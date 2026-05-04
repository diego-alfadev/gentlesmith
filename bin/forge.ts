#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import {
  ensureRuntimeState,
  listLocalProfiles,
  resolveRuntimePaths,
} from "./runtime";
import { bootstrapRuntime } from "./init";
import { discoverRuntime, summarizeDiscovery, type DiscoverySnapshot } from "./discovery";

const PATHS = resolveRuntimePaths();

interface ProfileDoc {
  name?: string;
  description?: string;
  include?: string[];
  skills?: string[];
  [key: string]: unknown;
}

interface ForgePlan {
  profileName: string;
  profilePath: string;
  fragmentRefs: string[];
  files: Array<{ path: string; content: string }>;
}

interface ProfileSelection {
  profileName: string;
  profilePath: string;
  profile: ProfileDoc;
}

export async function runForge(args = process.argv.slice(3)): Promise<void> {
  await ensureRuntimeState(PATHS);
  const bootstrap = await bootstrapRuntime(PATHS);
  const snapshot = bootstrap.snapshot ?? await discoverRuntime(PATHS);

  const manual = args.includes("--manual") || args.includes("--local");
  if (!manual) {
    printForgePrompt(snapshot, bootstrap.profileName);
    return;
  }

  console.log("gentlesmith forge — manual local profile personalizer");
  console.log("(fallback mode: writes runtime-local fragments only)\n");

  let plan: ForgePlan;
  try {
    plan = await buildForgePlan();
  } catch (err) {
    if (isExitPromptError(err)) {
      console.log("\nAborted.");
      process.exit(0);
    }
    throw err;
  }

  console.log("\nFiles that will be written:");
  for (const file of plan.files) {
    const status = existsSync(file.path) ? "update" : "create";
    console.log(`  ${status.padEnd(6)} ${formatRuntimePath(file.path)}`);
  }
  console.log("\nProfile includes:");
  for (const ref of plan.fragmentRefs) console.log(`  + ${ref}`);

  let proceed: boolean;
  try {
    proceed = await confirm({ message: "Write these changes?", default: true });
  } catch (err) {
    if (isExitPromptError(err)) {
      console.log("\nAborted.");
      process.exit(0);
    }
    throw err;
  }

  if (!proceed) {
    console.log("Aborted — no files written.");
    return;
  }

  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }

  console.log(`\nForged profile: ${plan.profileName}`);
  console.log("Next steps:");
  console.log("  1. Review generated fragments in ~/.gentlesmith/fragments-local/");
  console.log("  2. Preview render: gentlesmith sync");
  console.log("  3. Apply render:   gentlesmith sync --apply");
}

async function buildForgePlan(): Promise<ForgePlan> {
  const selection = await selectProfile();
  const baseSlug = selection.profileName.replace(/^local-/, "");
  const slug = toSlug(await input({
    message: "Fragment slug:",
    default: baseSlug,
    validate: (value) => toSlug(value).length > 0 || "Use at least one letter or number",
  }));

  const files: Array<{ path: string; content: string }> = [];
  const fragmentRefs: string[] = [];

  const includePersona = await confirm({
    message: "Forge a local persona fragment?",
    default: true,
  });
  if (includePersona) {
    const tone = await input({
      message: "Preferred tone:",
      default: "Direct, precise, technically critical",
    });
    const language = await input({
      message: "Language behavior:",
      default: "Mirror the user's language",
    });
    const pushback = await confirm({
      message: "Should the agent push back when something is questionable?",
      default: true,
    });
    const teaching = await select({
      message: "Teaching style:",
      choices: [
        { name: "Concepts first when needed", value: "Explain the concept briefly before implementation when it prevents future mistakes." },
        { name: "Execution first", value: "Execute directly unless the user explicitly asks for teaching." },
        { name: "Mentor mode", value: "Teach actively with short explanations and concrete examples." },
      ],
    });

    const ref = `persona/${slug}`;
    fragmentRefs.push(ref);
    files.push({
      path: join(PATHS.localFragmentsDir, `${ref}.md`),
      content: buildPersonaFragment({ tone, language, pushback, teaching }),
    });
  }

  const includeEnv = await confirm({
    message: "Forge local environment fragments?",
    default: true,
  });
  if (includeEnv) {
    const os = await input({
      message: "OS / platform:",
      default: process.platform,
    });
    const shell = await input({
      message: "Shell:",
      default: process.env.SHELL?.split("/").pop() ?? "",
    });
    const toolchain = await input({
      message: "Main toolchain/runtimes:",
      default: "TypeScript/Bun",
    });
    const containers = await input({
      message: "Container runtime (blank if none):",
      default: "",
    });
    const deployment = await input({
      message: "Deployment/services context (blank if none):",
      default: "",
    });

    fragmentRefs.push("env/system");
    files.push({
      path: join(PATHS.localFragmentsDir, "env/system.md"),
      content: buildSystemFragment({ os, shell }),
    });

    if (toolchain.trim() || containers.trim()) {
      fragmentRefs.push("env/toolchain");
      files.push({
        path: join(PATHS.localFragmentsDir, "env/toolchain.md"),
        content: buildToolchainFragment({ toolchain, containers }),
      });
    }

    if (deployment.trim()) {
      fragmentRefs.push("env/deployment");
      files.push({
        path: join(PATHS.localFragmentsDir, "env/deployment.md"),
        content: buildDeploymentFragment(deployment),
      });
    }
  }

  const profile = selection.profile;
  const currentInclude = Array.isArray(profile.include) ? profile.include : [];
  profile.name = profile.name ?? selection.profileName;
  profile.description = profile.description ?? "Generated by gentlesmith forge";
  profile.include = unique([...currentInclude, ...fragmentRefs]);

  files.push({
    path: selection.profilePath,
    content: stringifyYAML(profile),
  });

  return {
    profileName: selection.profileName,
    profilePath: selection.profilePath,
    fragmentRefs,
    files,
  };
}

async function selectProfile(): Promise<ProfileSelection> {
  const profiles = await listLocalProfiles(PATHS);
  const choices = [
    ...profiles.map((profile) => ({ name: profile.name, value: profile.path })),
    { name: "create new local profile", value: "__create" },
  ];

  const picked = profiles.length === 0
    ? "__create"
    : await select({ message: "Profile to forge:", choices });

  if (picked === "__create") {
    const rawName = await input({
      message: "New profile name:",
      default: "local-forged",
      validate: (value) => toSlug(value).length > 0 || "Use at least one letter or number",
    });
    const name = toLocalProfileName(rawName);
    const path = join(PATHS.localProfilesDir, `${name}.yaml`);
    const profile: ProfileDoc = existsSync(path)
      ? parseYAML(await readFile(path, "utf8")) as ProfileDoc
      : { name, description: "Generated by gentlesmith forge", include: [] };
    return { profileName: name, profilePath: path, profile };
  }

  const profileName = picked.split("/").pop()!.replace(/\.yaml$/, "");
  const profile = parseYAML(await readFile(picked, "utf8")) as ProfileDoc;
  return { profileName, profilePath: picked, profile };
}

function buildPersonaFragment(input: {
  tone: string;
  language: string;
  pushback: boolean;
  teaching: string;
}): string {
  return [
    "# Local Persona",
    "",
    `- **Tone**: ${input.tone.trim()}`,
    `- **Language**: ${input.language.trim()}`,
    `- **Pushback**: ${input.pushback ? "Challenge questionable assumptions with concise technical reasoning." : "Stay mostly execution-focused and avoid unsolicited debate."}`,
    `- **Teaching**: ${input.teaching}`,
    "",
    "Prefer concrete examples, concise explanations, and verified claims.",
    "",
  ].join("\n");
}

function buildSystemFragment(input: { os: string; shell: string }): string {
  return [
    "# Local System",
    "",
    `- **OS / platform**: ${input.os.trim() || "unspecified"}`,
    `- **Shell**: ${input.shell.trim() || "unspecified"}`,
    "- **Config source**: generated by `gentlesmith forge` into runtime-local state.",
    "",
  ].join("\n");
}

function buildToolchainFragment(input: { toolchain: string; containers: string }): string {
  const lines = [
    "# Local Toolchain",
    "",
    `- **Main toolchain/runtimes**: ${input.toolchain.trim() || "unspecified"}`,
  ];

  if (input.containers.trim()) {
    lines.push(`- **Containers**: ${input.containers.trim()}`);
  }

  lines.push("", "Prefer project-local commands when available. Verify before assuming tool versions.", "");
  return lines.join("\n");
}

function buildDeploymentFragment(deployment: string): string {
  return [
    "# Local Deployment Context",
    "",
    deployment.trim(),
    "",
    "Never hardcode credentials or tokens. Use documented environment variables or secret stores.",
    "",
  ].join("\n");
}

function toLocalProfileName(value: string): string {
  const slug = toSlug(value.replace(/^local-/, ""));
  return `local-${slug}`;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function formatRuntimePath(path: string): string {
  return path.replace(`${PATHS.runtimeHome}/`, "~/.gentlesmith/");
}

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ExitPromptError"
  );
}

function printForgePrompt(snapshot?: DiscoverySnapshot, profileName = "local-default"): void {
  const discoveryLines = snapshot ? summarizeDiscovery(snapshot).map((line) => `- ${line}`).join("\n") : "- not available";
  console.log(`# gentlesmith forge — LLM handoff

You are helping me forge a gentlesmith local profile.

Goal:
- Interview me briefly.
- Generate runtime-local fragments only.
- Update a selected local profile.
- Do not edit package built-ins.
- Use the detected local gentle-ai/agent/toolchain context below.

Current profile:
- ${profileName}

Detected runtime:
${discoveryLines}

First read:
- README.md
- GENTLE_AI_CONTRACT.md
- CATALOG.md
- profiles/jarvis.yaml
- profiles/surgical.yaml

Then ask focused questions, max 2 per round:

1. Persona
- desired tone
- language behavior
- how much pushback
- teaching/execution balance

2. Workflow/rules
- safety preferences
- commit conventions
- review/TDD preferences

3. Environment
- OS/shell
- main runtimes/toolchains
- container/deployment context
- secrets policy, without asking for secrets

4. Capabilities
- skills I want referenced/toggled in the profile
- gentle-ai integrations detected or desired (Engram, Context7, SDD / Agent Teams Lite)
- whether this profile should be registered as an OpenCode selectable agent

When ready, propose exact writes:
- ~/.gentlesmith/fragments-local/persona/<slug>.md
- ~/.gentlesmith/fragments-local/rules/<slug>.md if needed
- ~/.gentlesmith/fragments-local/env/<name>.md when concrete
- ~/.gentlesmith/profiles/<profile>.yaml

Ask for confirmation before writing.
After writing, run:
- gentlesmith sync
- gentlesmith export --profile <profile>

Never write credentials or machine secrets.

If the user wants the old deterministic local wizard, tell them to run:
- gentlesmith forge --manual
`);
}
