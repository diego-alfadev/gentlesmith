#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import {
  ensureRuntimeState,
  listBuiltInProfiles,
  listLocalProfiles,
  loadProfile,
  resolveFragmentPath,
  resolveRuntimePaths,
  resolveUserPath,
  type ProfileSpec,
} from "./runtime";
import { bootstrapRuntime } from "./init";
import { discoverRuntime, summarizeDiscovery, type DiscoverySnapshot } from "./discovery";
import {
  buildForgeHandoff,
  buildProfileWorkbenchContext,
  buildWorkbenchReadme,
  slugify,
  timestamp,
  writeProfileWorkbenchBundle,
  type WorkbenchSourceMaterial,
} from "./workbench";

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

interface ForgeArgs {
  name?: string;
  from?: string;
  profile?: string;
  out?: string;
  env: EnvMode;
  envFrom?: string;
  manual: boolean;
}

interface ForgeProfileChoice {
  name: string;
  path: string;
  isLocal: boolean;
}

type EnvMode = "inherit" | "agnostic";

interface EnvBaseline {
  mode: EnvMode;
  sourceProfileName?: string;
  sourceProfilePath?: string;
  refs: string[];
  content: string;
}

function parseForgeArgs(args: string[]): ForgeArgs {
  return {
    name: readFlag(args, "--name"),
    from: readFlag(args, "--from"),
    profile: readFlag(args, "--profile"),
    out: readFlag(args, "--out"),
    env: parseEnvMode(readFlag(args, "--env")),
    envFrom: readFlag(args, "--env-from"),
    manual: args.includes("--manual") || args.includes("--local"),
  };
}

export async function runForge(args = process.argv.slice(3)): Promise<void> {
  await ensureRuntimeState(PATHS);
  const bootstrap = await bootstrapRuntime(PATHS);
  const snapshot = bootstrap.snapshot ?? await discoverRuntime(PATHS);
  const parsed = parseForgeArgs(args);

  if (!parsed.manual) {
    await writeForgeBundle(parsed, snapshot, bootstrap.profileName);
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

async function writeForgeBundle(args: ForgeArgs, snapshot: DiscoverySnapshot, bootstrapProfileName: string): Promise<void> {
  const baseProfileName = args.from ?? args.profile ?? bootstrapProfileName ?? "jarvis";
  const profile = await resolveAnyProfile(baseProfileName);
  const profileSpec = await loadProfile(PATHS, profile.name);
  const targetProfileName = args.name
    ? toLocalProfileName(args.name)
    : profile.isLocal
      ? profile.name
      : `local-${slugify(profile.name)}`;
  const envBaseline = await resolveEnvBaseline(args, profile, profileSpec);
  const intent = args.profile ? "improve-profile" : "create-profile";
  const outDir = resolveUserPath(args.out ?? join(PATHS.runtimeHome, "forges", `${timestamp()}-${targetProfileName}`));
  const sources = buildForgeSources(profile, profileSpec, snapshot, targetProfileName, envBaseline);
  const context = buildProfileWorkbenchContext({
    paths: PATHS,
    outDir,
    intent,
    profile: { ...profile, spec: profileSpec },
    sources,
    level: "adapted",
    discovery: summarizeDiscovery(snapshot),
    targetProfileName,
  });

  await writeProfileWorkbenchBundle({
    outDir,
    context,
    sources,
    handoff: buildForgeHandoff(context),
    readme: buildWorkbenchReadme(context),
  });

  console.log(`gentlesmith forge bundle written to: ${outDir}`);
  console.log("");
  console.log("Next:");
  console.log(`  1. Give ${join(outDir, "handoff.md")} to your agent.`);
  console.log(`  2. Let it create/refine ${targetProfileName} in ~/.gentlesmith.`);
  console.log(`  3. Review with: gentlesmith export --profile ${targetProfileName}`);
  console.log("  4. Apply only after review: gentlesmith sync --apply");
}

async function resolveAnyProfile(profileName: string): Promise<ForgeProfileChoice> {
  const profiles = [
    ...(await listLocalProfiles(PATHS)).map((profile) => ({ ...profile, isLocal: true })),
    ...(await listBuiltInProfiles(PATHS)).map((profile) => ({ ...profile, isLocal: false })),
  ];
  const match = profiles.find((profile) => profile.name === profileName);
  if (!match) {
    console.error(`Profile not found: ${profileName}`);
    console.error("Run `gentlesmith browse` or inspect profiles before forging from it.");
    process.exit(1);
  }
  return match;
}

function buildForgeSources(
  profile: ForgeProfileChoice,
  profileSpec: ProfileSpec,
  snapshot: DiscoverySnapshot,
  targetProfileName: string,
  envBaseline: EnvBaseline,
): WorkbenchSourceMaterial[] {
  return [
    {
      type: "fragment",
      name: `base-profile/${profile.name}`,
      originalPath: profile.path,
      bundleFile: `sources/base-profile-${slugify(profile.name)}.yaml`,
      content: stringifyYAML(profileSpec),
    },
    {
      type: "idea",
      name: `forge-${targetProfileName}`,
      bundleFile: "sources/forge-request.md",
      content: [
        "# Forge request",
        "",
        `Create or refine runtime-local profile \`${targetProfileName}\`.`,
        `Base/current profile: \`${profile.name}\`.`,
        "",
        "Use discovery and existing env/toolchain context when useful.",
        "Keep the result compact, developer-focused, and low-intrusion unless the user asks otherwise.",
        "",
      ].join("\n"),
    },
    {
      type: "idea",
      name: envBaseline.mode === "agnostic" ? "env-policy" : "env-baseline",
      originalPath: envBaseline.sourceProfilePath,
      bundleFile: envBaseline.mode === "agnostic" ? "sources/env-policy.md" : "sources/env-baseline.md",
      content: envBaseline.content,
    },
    {
      type: "idea",
      name: "discovery-summary",
      bundleFile: "sources/discovery.md",
      content: [
        "# Discovery summary",
        "",
        ...summarizeDiscovery(snapshot).map((line) => `- ${line}`),
        "",
        "Recommended fragments:",
        ...snapshot.recommendations.fragments.map((ref) => `- ${ref}`),
        "",
        "Recommended targets:",
        ...snapshot.recommendations.targets.map((target) => `- ${target}`),
        "",
      ].join("\n"),
    },
    buildSkillsDiscoverySource(snapshot),
    buildBridgeReadinessSource(snapshot),
  ];
}

function buildSkillsDiscoverySource(snapshot: DiscoverySnapshot): WorkbenchSourceMaterial {
  const bySource = new Map<string, typeof snapshot.skills>();
  for (const skill of snapshot.skills) {
    const current = bySource.get(skill.source) ?? [];
    current.push(skill);
    bySource.set(skill.source, current);
  }

  const lines = [
    "# Skills discovery",
    "",
    `Skills CLI detected: ${snapshot.tools.skillsCli.detected ? "yes" : "no"}.`,
    snapshot.tools.skillsCli.version ? `Skills CLI version: ${snapshot.tools.skillsCli.version}.` : "",
    "",
    "Installed skills:",
  ].filter(Boolean);

  if (snapshot.skills.length === 0) {
    lines.push("- none detected in known roots");
  } else {
    for (const [source, skills] of bySource) {
      lines.push(``, `## ${source}`);
      for (const skill of skills) lines.push(`- ${skill.name} — ${skill.path}`);
    }
  }

  lines.push(
    "",
    "Use L0-L3 incorporation semantics:",
    "- L0 install-only: no profile write; user invokes manually.",
    "- L1 reference: compact `references/<slug>.md` with when-to-use guidance.",
    "- L2 adapted: compact durable behavior in persona/rules/workflows.",
    "- L3 embedded: core persona/rule edit; highest blast radius.",
    "",
    "Do not vendor third-party skill bodies into Gentlesmith built-ins. Prefer upstream installation/reference, e.g. skills.sh or the user's existing skill roots.",
    "For external discovery, use `gentlesmith skills find <query>` as an optional step; do not block forge on network access.",
    "",
  );

  return {
    type: "idea",
    name: "skills-discovery",
    bundleFile: "sources/skills-discovery.md",
    content: lines.join("\n"),
  };
}

function buildBridgeReadinessSource(snapshot: DiscoverySnapshot): WorkbenchSourceMaterial {
  return {
    type: "idea",
    name: "gentle-ai-bridge-readiness",
    bundleFile: "sources/gentle-ai-bridge.md",
    content: [
      "# Gentle-ai bridge readiness",
      "",
      `gentle-ai detected: ${snapshot.tools.gentleAi.detected ? "yes" : "no"}.`,
      snapshot.tools.gentleAi.version ? `gentle-ai version: ${snapshot.tools.gentleAi.version}.` : "",
      snapshot.tools.gentleAi.path ? `gentle-ai path: ${snapshot.tools.gentleAi.path}.` : "",
      "",
      "Current contract:",
      "- Gentlesmith works standalone by writing Workbench bundles.",
      "- This bundle can be handed to any coding agent as context.",
      "- No direct gentle-ai bridge is invoked from Gentlesmith yet.",
      "- Do not assume gentle-ai plugin/TUI transport until its public contract is verified.",
      "",
      "Future bridge direction:",
      "- gentle-ai may tunnel this bundle as agent context from its TUI.",
      "- Gentlesmith should keep bundles self-contained so the bridge is an optimization, not a requirement.",
      "",
    ].filter(Boolean).join("\n"),
  };
}

async function resolveEnvBaseline(
  args: ForgeArgs,
  baseProfile: ForgeProfileChoice,
  baseProfileSpec: ProfileSpec,
): Promise<EnvBaseline> {
  if (args.env === "agnostic") {
    return {
      mode: "agnostic",
      refs: [],
      content: [
        "# Env Policy",
        "",
        "Mode: agnostic.",
        "",
        "Do not include local `env/*` fragments unless the user explicitly asks for machine-specific context.",
        "Use this for portable profiles, orchestrators, sub-agents, framework agents, or catalogued exports where local assumptions would be noise.",
        "",
      ].join("\n"),
    };
  }

  if (args.envFrom) {
    const source = await resolveAnyProfile(args.envFrom);
    const sourceSpec = await loadProfile(PATHS, source.name);
    const refs = envRefsFromProfile(sourceSpec);
    return buildEnvBaselineFromRefs(source, refs);
  }

  const baseRefs = envRefsFromProfile(baseProfileSpec);
  if (baseProfile.isLocal && baseRefs.length > 0) {
    return buildEnvBaselineFromRefs(baseProfile, baseRefs);
  }

  const localSource = await findLocalEnvBaselineProfile();
  if (localSource) return buildEnvBaselineFromRefs(localSource.profile, localSource.refs);

  return {
    mode: "inherit",
    refs: [],
    content: [
      "# Env Baseline",
      "",
      "Mode: inherit.",
      "",
      "No existing local `env/*` fragments were found.",
      "",
      "If the forged profile should be machine-aware, ask the user for concrete OS/toolchain facts and create compact runtime-local `env/*` fragments.",
      "If the profile should be portable, keep it env-agnostic and avoid adding local assumptions.",
      "",
    ].join("\n"),
  };
}

async function findLocalEnvBaselineProfile(): Promise<{ profile: ForgeProfileChoice; refs: string[] } | null> {
  const localProfiles = await listLocalProfiles(PATHS);
  const ordered = [...localProfiles].sort((a, b) => envProfilePriority(a.name) - envProfilePriority(b.name));

  for (const localProfile of ordered) {
    const spec = await loadProfile(PATHS, localProfile.name);
    const refs = envRefsFromProfile(spec);
    if (refs.length > 0) {
      return { profile: { ...localProfile, isLocal: true }, refs };
    }
  }

  return null;
}

function envProfilePriority(name: string): number {
  if (name === "local-diego" || name === "diego-local") return 0;
  if (name.startsWith("local-")) return 1;
  return 2;
}

function envRefsFromProfile(spec: ProfileSpec): string[] {
  return unique((spec.include ?? []).filter((ref) => ref.startsWith("env/")));
}

async function buildEnvBaselineFromRefs(profile: ForgeProfileChoice, refs: string[]): Promise<EnvBaseline> {
  if (refs.length === 0) {
    return {
      mode: "inherit",
      sourceProfileName: profile.name,
      sourceProfilePath: profile.path,
      refs: [],
      content: [
        "# Env Baseline",
        "",
        "Mode: inherit.",
        `Source profile: \`${profile.name}\`.`,
        "",
        "The selected env source profile has no `env/*` includes.",
        "Do not invent local environment facts. Ask the user if this profile should become machine-aware.",
        "",
      ].join("\n"),
    };
  }

  const sections: string[] = [
    "# Env Baseline",
    "",
    "Mode: inherit.",
    `Source profile: \`${profile.name}\`.`,
    `Source path: \`${profile.path}\`.`,
    "",
    "Env refs:",
    ...refs.map((ref) => `- \`${ref}\``),
    "",
    "Use this as reusable baseline context when forging variants. Preserve useful refs in the target profile unless it should be env-agnostic.",
    "Keep secrets out of profile fragments.",
    "",
  ];

  for (const ref of refs) {
    const path = resolveFragmentPath(PATHS, ref);
    sections.push(`## ${ref}`, "", `Source: \`${path}\``, "");
    if (existsSync(path)) {
      sections.push(await readFile(path, "utf8"));
    } else {
      sections.push(`Missing fragment for \`${ref}\`. Do not recreate it without confirming intended content.`);
    }
    sections.push("");
  }

  return {
    mode: "inherit",
    sourceProfileName: profile.name,
    sourceProfilePath: profile.path,
    refs,
    content: sections.join("\n"),
  };
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

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function parseEnvMode(value: string | undefined): EnvMode {
  if (!value || value === "inherit") return "inherit";
  if (value === "agnostic" || value === "none" || value === "skip") return "agnostic";

  console.error(`Invalid --env mode: ${value}`);
  console.error("Use `--env inherit` or `--env agnostic`.");
  process.exit(1);
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
