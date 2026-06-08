#!/usr/bin/env bun

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
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
import { discoverRuntime, summarizeDiscovery, writeDiscoverySnapshot, type DiscoverySnapshot } from "./discovery";
import {
  buildForgeHandoff,
  buildProfileWorkbenchContext,
  buildWorkbenchReadme,
  slugify,
  timestamp,
  writeProfileWorkbenchBundle,
  type WorkbenchSourceMaterial,
} from "./workbench";
import { modularizeAgentsProfile } from "../src/application/modularize-agents";

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
  openWith?: string;
  quick: boolean;
  blank: boolean;
  custom: boolean;
  kind?: ProfileKind;
  fromAgents?: string;
  target?: string;
  dryRun: boolean;
}

type ProfileKind = "developer" | "domain" | "blank" | "subagent";
type ForgeMode = "guided" | "quick" | "blank" | "custom" | "improve";

interface ForgeInterview {
  mode: ForgeMode;
  kind: ProfileKind;
  baseProfileName: string;
  includeEnv: boolean;
  selectedFragments?: string[];
  selectedSkills: string[];
  notes: string;
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
  const name = readFlag(args, "--name") ?? readPositionalName(args);
  return {
    name,
    from: readFlag(args, "--from"),
    profile: readFlag(args, "--profile"),
    out: readFlag(args, "--out"),
    env: parseEnvMode(readFlag(args, "--env")),
    envFrom: readFlag(args, "--env-from"),
    openWith: readFlag(args, "--open-with") ?? (args.includes("--open") ? "editor" : undefined),
    quick: args.includes("--quick") || args.includes("--yes"),
    blank: args.includes("--blank"),
    custom: args.includes("--custom"),
    kind: parseProfileKind(readFlag(args, "--kind")),
    fromAgents: readFlag(args, "--from-agents") ?? readFlag(args, "--from-agents-md"),
    target: readFlag(args, "--target"),
    dryRun: args.includes("--dry-run"),
    manual: args.includes("--manual") || args.includes("--local"),
  };
}

export async function runForge(args = process.argv.slice(3)): Promise<void> {
  const parsed = parseForgeArgs(args);

  if (parsed.fromAgents) {
    await writeAgentsProfileDraft(parsed);
    return;
  }

  await ensureRuntimeState(PATHS);
  const bootstrap = await bootstrapRuntime(PATHS);
  const snapshot = bootstrap.snapshot ?? await discoverRuntime(PATHS);
  await writeDiscoverySnapshot(PATHS, snapshot);

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
  console.log(`  2. Preview switch: gentlesmith apply ${plan.profileName}`);
  console.log(`  3. Apply switch:   gentlesmith apply ${plan.profileName} --apply`);
}

async function writeForgeBundle(args: ForgeArgs, snapshot: DiscoverySnapshot, bootstrapProfileName: string): Promise<void> {
  const interview = await resolveForgeInterview(args, snapshot, bootstrapProfileName);
  const profile = await resolveAnyProfile(interview.baseProfileName);
  const loadedProfileSpec = await loadProfile(PATHS, profile.name);
  const profileSpec = interview.selectedFragments
    ? { ...loadedProfileSpec, kind: interview.kind, include: interview.selectedFragments }
    : { ...loadedProfileSpec, kind: loadedProfileSpec.kind ?? interview.kind };
  const targetProfileName = args.name
    ? toProfileName(args.name)
    : profile.isLocal
      ? profile.name
      : slugify(profile.name);
  const envBaseline = interview.includeEnv
    ? await resolveEnvBaseline(args, profile, profileSpec)
    : buildEnvAgnosticBaseline(interview);
  const intent = args.profile ? "improve-profile" : "create-profile";
  const outDir = resolveUserPath(args.out ?? join(PATHS.runtimeHome, "forges", `${timestamp()}-${targetProfileName}`));
  const sources = buildForgeSources(profile, profileSpec, snapshot, targetProfileName, envBaseline, interview);
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

  console.log(`gentlesmith forge draft written to: ${outDir}`);
  console.log("");
  console.log("Next:");
  console.log(`  1. Open ${join(outDir, "handoff.md")} with your coding agent.`);
  console.log(`  2. Let it create/refine profile: ${targetProfileName}`);
  console.log(`  3. Review: gentlesmith export --profile ${targetProfileName}`);
  console.log(`  4. Preview: gentlesmith apply ${targetProfileName.replace(/^local-/, "")}`);
  console.log(`  5. Apply:  gentlesmith apply ${targetProfileName.replace(/^local-/, "")} --apply`);

  if (args.openWith) {
    openForgeHandoff(args.openWith, outDir, join(outDir, "handoff.md"));
  }
}

async function writeAgentsProfileDraft(args: ForgeArgs): Promise<void> {
  if (!args.fromAgents) throw new Error("Missing --from-agents path.");
  const profileName = args.name ? requireProfileNameSlug(toProfileName(args.name), "--name") : undefined;
  const outDir = resolveUserPath(args.out ?? `.gentlesmith-v1-draft${profileName ? `-${profileName}` : ""}`);
  const result = await modularizeAgentsProfile({
    sourcePath: resolveUserPath(args.fromAgents),
    outDir,
    profileName,
    targetName: args.target,
    dryRun: args.dryRun,
  });

  console.log(result.wroteFiles ? "gentlesmith forge draft written" : "gentlesmith forge assimilation preview");
  console.log(`Profile: ${result.profileName}`);
  console.log(`Draft:   ${result.outDir}`);
  console.log(`Source:  ${result.sourcePath}`);
  console.log("");
  console.log("Artifacts:");
  for (const artifact of result.artifacts) {
    console.log(`  + ${artifact.type.padEnd(14)} ${artifact.name} -> ${artifact.ref}`);
  }
  if (result.skipped.length > 0) {
    console.log("\nSkipped:");
    for (const skipped of result.skipped) console.log(`  - ${skipped.title}: ${skipped.reason}`);
  }
  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }
  console.log("\nNext:");
  console.log("  1. Inspect the modular profile:");
  console.log(`     ${result.nextCommands.inspect}`);
  console.log("  2. Export a local review bundle:");
  console.log(`     ${result.nextCommands.exportReview}`);
  console.log("  3. Optional public-share check:");
  console.log(`     ${result.nextCommands.exportPublic}`);
  console.log("  4. Optional sync preview for this target:");
  console.log(`     ${result.nextCommands.addTarget}        # if the target is not installed yet`);
  console.log(`     ${result.nextCommands.bindTarget}`);
  console.log(`     ${result.nextCommands.previewSync}`);
  console.log("  5. Apply only after reviewing the preview:");
  console.log(`     ${result.nextCommands.applySync}`);
  console.log("\nReview/edit the artifact files before exporting or applying anywhere.");
}

function openForgeHandoff(openWith: string, bundleDir: string, handoffPath: string): void {
  const target = openWith.toLowerCase();
  const prompt = `Read this Gentlesmith handoff and help me create/refine the requested profile. Follow allowed writes only: ${handoffPath}`;

  const launchers: Record<string, { command: string; args: string[]; label: string }> = {
    editor: { command: "code", args: [bundleDir, handoffPath], label: "VS Code" },
    code: { command: "code", args: [bundleDir, handoffPath], label: "VS Code" },
    codex: { command: "codex", args: [prompt], label: "Codex" },
    opencode: { command: "opencode", args: [process.cwd(), "--prompt", prompt], label: "OpenCode" },
    claude: { command: "claude", args: ["--add-dir", PATHS.runtimeHome, prompt], label: "Claude" },
    gemini: { command: "gemini", args: ["-i", prompt, "--include-directories", PATHS.runtimeHome], label: "Gemini" },
  };

  const launcher = launchers[target];
  if (!launcher) {
    console.log(`\nUnknown handoff target: ${openWith}`);
    console.log("Use one of: editor, codex, opencode, claude, gemini.");
    return;
  }

  if (spawnSync("which", [launcher.command], { stdio: "ignore" }).status !== 0) {
    console.log(`\n${launcher.label} command not found. Open manually: ${handoffPath}`);
    return;
  }

  console.log(`\nOpening handoff with ${launcher.label}...`);
  const result = spawnSync(launcher.command, launcher.args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.log(`\nCould not open ${launcher.label}. Open manually: ${handoffPath}`);
  }
}

async function resolveForgeInterview(
  args: ForgeArgs,
  snapshot: DiscoverySnapshot,
  bootstrapProfileName: string,
): Promise<ForgeInterview> {
  if (args.profile) {
    const current = await loadProfile(PATHS, args.profile);
    return {
      mode: "improve",
      kind: args.kind ?? current.kind ?? "developer",
      baseProfileName: args.profile,
      includeEnv: args.env !== "agnostic",
      selectedSkills: [],
      notes: "Improve existing profile without changing its base unless the user asks.",
    };
  }

  if (args.quick) {
    const kind = args.kind ?? (args.blank ? "blank" : "developer");
    return {
      mode: args.blank ? "blank" : "quick",
      kind,
      baseProfileName: args.from ?? baseForKind(kind, bootstrapProfileName),
      includeEnv: args.env !== "agnostic" && kind === "developer" && !args.blank,
      selectedSkills: relevantSkillNames(snapshot, args.name),
      notes: "Quick mode: prepare a bundle without an interactive interview.",
    };
  }

  if (args.blank) {
    return {
      mode: "blank",
      kind: args.kind ?? "blank",
      baseProfileName: args.from ?? "blank",
      includeEnv: false,
      selectedSkills: [],
      notes: "Blank canvas mode: do not include persona/rules/env unless the user or receiving agent explicitly adds them.",
    };
  }

  if (args.custom) return promptCustomInterview(args, snapshot, bootstrapProfileName);

  return promptGuidedInterview(args, snapshot, bootstrapProfileName);
}

async function promptGuidedInterview(
  args: ForgeArgs,
  snapshot: DiscoverySnapshot,
  bootstrapProfileName: string,
): Promise<ForgeInterview> {
  const guessedKind = guessKind(args.name);
  const kind = args.kind ?? await select<ProfileKind>({
    message: "What kind of profile is this?",
    default: guessedKind,
    choices: [
      { name: "Developer profile — coding agent behavior", value: "developer" },
      { name: "Domain specialist — trading, writing, research, etc.", value: "domain" },
      { name: "Blank canvas — minimal/purist", value: "blank" },
      { name: "Subagent / framework agent — portable role", value: "subagent" },
    ],
  });
  const baseProfileName = args.from ?? baseForKind(kind, bootstrapProfileName);
  const includeEnv = kind === "developer"
    ? await confirm({ message: "Include local env/toolchain as selected context?", default: true })
    : await confirm({ message: "Keep this profile portable/env-agnostic?", default: true }).then((portable) => !portable);
  const selectedSkills = await promptSkills(snapshot, args.name);
  const notes = await input({
    message: "What should this profile be good at?",
    default: defaultNotesForKind(kind, args.name),
  });
  return { mode: "guided", kind, baseProfileName, includeEnv, selectedSkills, notes };
}

async function promptCustomInterview(
  args: ForgeArgs,
  snapshot: DiscoverySnapshot,
  bootstrapProfileName: string,
): Promise<ForgeInterview> {
  const kind = args.kind ?? await select<ProfileKind>({
    message: "Profile kind:",
    choices: [
      { name: "Developer", value: "developer" },
      { name: "Domain specialist", value: "domain" },
      { name: "Blank canvas", value: "blank" },
      { name: "Subagent / framework agent", value: "subagent" },
    ],
  });
  const builtIns = await listBuiltInProfiles(PATHS);
  const locals = await listLocalProfiles(PATHS);
  const baseProfileName = args.from ?? await select<string>({
    message: "Base preset/profile:",
    choices: [
      ...builtIns.map((profile) => ({ name: `${profile.name} (bundled)`, value: profile.name })),
      ...locals.map((profile) => ({ name: `${profile.name} (local)`, value: profile.name })),
    ],
    default: baseForKind(kind, bootstrapProfileName),
  });
  const baseSpec = await loadProfile(PATHS, baseProfileName);
  const recommended = new Set([...baseSpec.include, ...snapshot.recommendations.fragments]);
  const available = await listAvailableFragments();
  const selectedFragments = await checkbox<string>({
    message: "Fragments to include:",
    choices: available.map((ref) => ({ name: ref, value: ref, checked: recommended.has(ref) })),
    required: false,
  });
  const includeEnv = selectedFragments.some((ref) => ref.startsWith("env/"));
  const selectedSkills = await promptSkills(snapshot, args.name);
  const notes = await input({ message: "Custom notes for the receiving agent:", default: defaultNotesForKind(kind, args.name) });
  return { mode: "custom", kind, baseProfileName, includeEnv, selectedFragments, selectedSkills, notes };
}

async function promptSkills(snapshot: DiscoverySnapshot, profileName?: string): Promise<string[]> {
  const choices = relevantSkills(snapshot, profileName).map((skill) => ({
    name: `${skill.name} (${skill.source})`,
    value: skill.name,
    checked: isSkillRelevant(skill.name, profileName),
  }));
  if (choices.length === 0) return [];
  return checkbox<string>({
    message: "Skills to consider as references/adaptations:",
    choices,
    required: false,
  });
}

function relevantSkills(snapshot: DiscoverySnapshot, profileName?: string): typeof snapshot.skills {
  const sorted = [...snapshot.skills].sort((a, b) => Number(isSkillRelevant(b.name, profileName)) - Number(isSkillRelevant(a.name, profileName)) || a.name.localeCompare(b.name));
  return sorted.slice(0, 20);
}

function relevantSkillNames(snapshot: DiscoverySnapshot, profileName?: string): string[] {
  return relevantSkills(snapshot, profileName).filter((skill) => isSkillRelevant(skill.name, profileName)).map((skill) => skill.name);
}

function isSkillRelevant(skillName: string, profileName?: string): boolean {
  if (!profileName) return false;
  const words = toSlug(profileName).split("-").filter(Boolean);
  const skill = toSlug(skillName);
  return words.some((word) => skill.includes(word) || word.includes(skill));
}

async function listAvailableFragments(): Promise<string[]> {
  const refs = new Set<string>();
  await collectFragmentRefs(PATHS.builtInFragmentsDir, "", refs);
  await collectFragmentRefs(PATHS.localFragmentsDir, "", refs);
  return Array.from(refs).sort();
}

async function collectFragmentRefs(root: string, prefix: string, refs: Set<string>): Promise<void> {
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await collectFragmentRefs(path, rel, refs);
    if (entry.isFile() && entry.name.endsWith(".md")) refs.add(rel.replace(/\.md$/, ""));
  }
}

function baseForKind(kind: ProfileKind, bootstrapProfileName: string): string {
  if (kind === "developer") return "jarvis";
  if (kind === "blank" || kind === "domain" || kind === "subagent") return "blank";
  return bootstrapProfileName || "jarvis";
}

function guessKind(name?: string): ProfileKind {
  const slug = toSlug(name ?? "");
  if (!slug) return "developer";
  if (["debug", "debugger", "review", "reviewer", "frontend", "backend", "architect", "coder", "developer"].some((word) => slug.includes(word))) return "developer";
  if (["worker", "subagent", "mastra", "agent"].some((word) => slug.includes(word))) return "subagent";
  return "domain";
}

function defaultNotesForKind(kind: ProfileKind, name?: string): string {
  if (kind === "developer") return `Developer assistant for ${name ?? "coding work"}; keep it practical and compact.`;
  if (kind === "domain") return `Domain specialist for ${name ?? "the requested domain"}; avoid developer boilerplate unless explicitly useful.`;
  if (kind === "subagent") return `Portable subagent role for ${name ?? "a framework/orchestrator"}; avoid local machine assumptions.`;
  return "Blank canvas; ask focused questions before adding durable behavior.";
}

function buildEnvAgnosticBaseline(interview: ForgeInterview): EnvBaseline {
  return {
    mode: "agnostic",
    refs: [],
    content: [
      "# Env Policy",
      "",
      `Mode: ${interview.includeEnv ? "reviewable" : "agnostic"}.`,
      "",
      "Do not include local `env/*` fragments unless explicitly selected or confirmed by the user.",
      "Use discovery snapshots as context, not as automatic profile content.",
      "",
    ].join("\n"),
  };
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
  interview: ForgeInterview,
): WorkbenchSourceMaterial[] {
  return [
    buildForgeIntentSource(targetProfileName, interview),
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
        `Forge mode: \`${interview.mode}\`.`,
        `Profile kind: \`${interview.kind}\`.`,
        "Use discovery and existing env/toolchain context when useful, but do not add local env/toolchain fragments unless the interview asks for them.",
        "Keep the result compact and aligned with the requested profile kind; do not force developer boilerplate into domain or blank profiles.",
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

function buildForgeIntentSource(targetProfileName: string, interview: ForgeInterview): WorkbenchSourceMaterial {
  const lines = [
    "# Forge intent",
    "",
    `Target profile: \`${targetProfileName}\``,
    `Mode: \`${interview.mode}\``,
    `Kind: \`${interview.kind}\``,
    `Base profile: \`${interview.baseProfileName}\``,
    `Include env/toolchain by default: ${interview.includeEnv ? "yes" : "no"}`,
    "",
    "Selected skills:",
    ...(interview.selectedSkills.length ? interview.selectedSkills.map((skill) => `- ${skill}`) : ["- none selected"]),
    "",
    "Selected deterministic fragments:",
    ...(interview.selectedFragments ? interview.selectedFragments.map((ref) => `- ${ref}`) : ["- use base profile defaults"]),
    "",
    "User notes:",
    interview.notes.trim() || "- none",
    "",
    "Guidance:",
    "- If mode is guided and important information is missing, ask up to two focused follow-up questions before writing.",
    "- If kind is domain/blank/subagent, do not inherit developer boilerplate unless explicitly selected above.",
    "- Write profile metadata with a compact `kind` field.",
    "- Treat discovery and skills as reviewable context, not automatic profile writes.",
    "",
  ];
  return { type: "idea", name: "forge-intent", bundleFile: "sources/forge-intent.md", content: lines.join("\n") };
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
  if (name.startsWith("local-")) return 0;
  return 1;
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
      default: "forged",
      validate: (value) => toSlug(value).length > 0 || "Use at least one letter or number",
    });
    const name = toProfileName(rawName);
    const path = join(PATHS.localProfilesDir, `${name}.yaml`);
    const profile: ProfileDoc = existsSync(path)
      ? parseYAML(await readFile(path, "utf8")) as ProfileDoc
      : { name, description: "Generated by gentlesmith forge", include: [] };
    return { profileName: name, profilePath: path, profile };
  }

  const profileName = basename(picked).replace(/\.yaml$/, "");
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

function requireProfileNameSlug(value: string, label: string): string {
  if (!value) throw new Error(`${label} must contain at least one letter or number.`);
  return value;
}

function toProfileName(value: string): string {
  return toSlug(value.replace(/^local-/, ""));
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

function readPositionalName(args: string[]): string | undefined {
  const flagsWithValues = new Set(["--name", "--from", "--profile", "--out", "--env", "--env-from", "--open-with", "--kind", "--from-agents", "--from-agents-md", "--target"]);
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (flagsWithValues.has(args[idx - 1])) continue;
    if (arg.startsWith("--")) continue;
    return arg;
  }
  return undefined;
}

function parseProfileKind(value: string | undefined): ProfileKind | undefined {
  if (!value) return undefined;
  if (["developer", "domain", "blank", "subagent"].includes(value)) return value as ProfileKind;
  console.error(`Invalid --kind: ${value}`);
  console.error("Use developer, domain, blank, or subagent.");
  process.exit(1);
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
