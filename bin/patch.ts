#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { input, select } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import {
  ensureRuntimeState,
  listBuiltInProfiles,
  listLocalProfiles,
  loadProfile,
  resolveFragmentPath,
  resolveRuntimePaths,
  resolveUserPath,
} from "./runtime";
import { discoverRuntime, summarizeDiscovery, type DiscoverySnapshot, type SkillHit } from "./discovery";
import {
  buildPatchHandoff,
  buildProfileWorkbenchContext,
  buildWorkbenchReadme,
  recommendedReviewProfile,
  slugify,
  timestamp,
  writeProfileWorkbenchBundle,
  type WorkbenchLevel,
  type WorkbenchSourceMaterial,
  type WorkbenchSourceType,
} from "./workbench";

const PATHS = resolveRuntimePaths();

type PatchLevel = WorkbenchLevel;
type SourceType = WorkbenchSourceType;

interface PatchArgs {
  profile?: string;
  idea?: string;
  fromSkill?: string;
  fromFile?: string;
  fromFragment?: string;
  level?: PatchLevel;
  out?: string;
}

interface ProfileChoice {
  name: string;
  path: string;
  isLocal: boolean;
}

type PatchSource = WorkbenchSourceMaterial;

export async function runPatch(args: string[]): Promise<void> {
  await ensureRuntimeState(PATHS);

  const parsed = parseArgs(args);
  const snapshot = await discoverRuntime(PATHS);
  const profile = await resolveProfile(parsed.profile);
  const level = parsed.level ?? await promptLevel();
  const source = await resolveSource(parsed, snapshot);
  const outDir = resolveUserPath(parsed.out ?? join(PATHS.runtimeHome, "patches", `${timestamp()}-${slugify(source.name)}`));
  const profileSpec = await loadProfile(PATHS, profile.name);
  const context = buildProfileWorkbenchContext({
    paths: PATHS,
    outDir,
    intent: "patch-profile",
    profile: { ...profile, spec: profileSpec },
    sources: [source],
    level,
    discovery: summarizeDiscovery(snapshot),
  });

  await writeProfileWorkbenchBundle({
    outDir,
    context,
    sources: [source],
    handoff: buildPatchHandoff(context),
    readme: buildWorkbenchReadme(context),
  });

  const reviewProfile = recommendedReviewProfile(profile);
  console.log(`gentlesmith patch bundle written to: ${outDir}`);
  console.log("");
  console.log("Next:");
  console.log(`  1. Give ${join(outDir, "handoff.md")} to your agent.`);
  console.log(`  2. Let it write runtime-local fragments/profile changes.`);
  console.log(`  3. Review: gentlesmith export --profile ${reviewProfile}`);
  console.log(`  4. Preview: gentlesmith apply ${reviewProfile.replace(/^local-/, "")}`);
  console.log(`  5. Apply:  gentlesmith apply ${reviewProfile.replace(/^local-/, "")} --apply`);
}

function parseArgs(args: string[]): PatchArgs {
  return {
    profile: readFlag(args, "--profile"),
    idea: readFlag(args, "--idea"),
    fromSkill: readFlag(args, "--from-skill"),
    fromFile: readFlag(args, "--from-file"),
    fromFragment: readFlag(args, "--from-fragment"),
    level: parseLevel(readFlag(args, "--level")),
    out: readFlag(args, "--out"),
  };
}

async function resolveProfile(profileName?: string): Promise<ProfileChoice> {
  const profiles = [
    ...(await listLocalProfiles(PATHS)).map((profile) => ({ ...profile, isLocal: true })),
    ...(await listBuiltInProfiles(PATHS)).map((profile) => ({ ...profile, isLocal: false })),
  ];

  if (profiles.length === 0) {
    console.error("No profiles found. Run `gentlesmith forge` first.");
    process.exit(1);
  }

  if (profileName) {
    const match = profiles.find((profile) => profile.name === profileName);
    if (!match) {
      console.error(`Profile not found: ${profileName}`);
      process.exit(1);
    }
    return match;
  }

  try {
    const picked = await select({
      message: "Profile to patch:",
      choices: profiles.map((profile) => ({
        name: `${profile.name}${profile.isLocal ? " (local)" : " (built-in)"}`,
        value: profile.path,
      })),
    });
    return profiles.find((profile) => profile.path === picked)!;
  } catch (err) {
    handlePromptExit(err);
    throw err;
  }
}

async function resolveSource(args: PatchArgs, snapshot: DiscoverySnapshot): Promise<PatchSource> {
  const sourceFlags = [args.idea, args.fromSkill, args.fromFile, args.fromFragment].filter(Boolean);
  if (sourceFlags.length > 1) {
    console.error("Use only one source: --idea, --from-skill, --from-file, or --from-fragment.");
    process.exit(1);
  }

  if (args.idea) return ideaSource(args.idea);
  if (args.fromSkill) return skillSource(args.fromSkill, snapshot.skills);
  if (args.fromFile) return fileSource(args.fromFile);
  if (args.fromFragment) return fragmentSource(args.fromFragment);

  try {
    const kind = await select<SourceType>({
      message: "Patch source:",
      choices: [
        { name: "Free-form idea", value: "idea" },
        { name: "Installed skill", value: "skill" },
        { name: "Markdown file", value: "file" },
        { name: "Gentlesmith fragment", value: "fragment" },
      ],
    });

    if (kind === "idea") {
      const idea = await input({ message: "What do you want to change?" });
      return ideaSource(idea);
    }
    if (kind === "skill") {
      const skill = await promptSkill(snapshot.skills);
      return skillSource(skill.name, snapshot.skills);
    }
    if (kind === "file") {
      const path = await input({ message: "Markdown file path:" });
      return fileSource(path);
    }
    const ref = await promptFragmentRef();
    return fragmentSource(ref);
  } catch (err) {
    handlePromptExit(err);
    throw err;
  }
}

function ideaSource(idea: string): PatchSource {
  const content = `# Patch idea\n\n${idea.trim()}\n`;
  return {
    type: "idea",
    name: idea.slice(0, 64) || "idea",
    content,
    bundleFile: "sources/idea.md",
  };
}

async function skillSource(name: string, skills: SkillHit[]): Promise<PatchSource> {
  const matches = skills.filter((skill) => skill.name === name || skill.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) {
    console.error(`Installed skill not found: ${name}`);
    console.error("Run `gentlesmith skills discover` to see available skills.");
    process.exit(1);
  }
  const skill = matches[0];
  return {
    type: "skill",
    name: skill.name,
    originalPath: skill.path,
    content: await readFile(skill.path, "utf8"),
    bundleFile: `sources/skill-${slugify(skill.name)}.md`,
  };
}

async function fileSource(pathInput: string): Promise<PatchSource> {
  const path = resolveUserPath(pathInput);
  if (!existsSync(path)) {
    console.error(`File not found: ${pathInput}`);
    process.exit(1);
  }
  return {
    type: "file",
    name: basename(path).replace(/\.[^.]+$/, ""),
    originalPath: path,
    content: await readFile(path, "utf8"),
    bundleFile: "sources/input.md",
  };
}

async function fragmentSource(ref: string): Promise<PatchSource> {
  const path = resolveFragmentPath(PATHS, ref);
  if (!existsSync(path)) {
    console.error(`Fragment not found: ${ref}`);
    process.exit(1);
  }
  return {
    type: "fragment",
    name: ref,
    originalPath: path,
    content: await readFile(path, "utf8"),
    bundleFile: `sources/fragment-${slugify(ref)}.md`,
  };
}

async function promptSkill(skills: SkillHit[]): Promise<SkillHit> {
  if (skills.length === 0) {
    console.error("No installed skills detected. Use --idea or install a skill first.");
    process.exit(1);
  }
  const picked = await select({
    message: "Installed skill:",
    choices: skills.map((skill) => ({
      name: `${skill.name} (${skill.source})`,
      value: skill.path,
    })),
  });
  return skills.find((skill) => skill.path === picked)!;
}

async function promptFragmentRef(): Promise<string> {
  const refs = await listFragmentRefs();
  if (refs.length === 0) {
    console.error("No fragments found.");
    process.exit(1);
  }
  return select({
    message: "Fragment:",
    choices: refs.map((ref) => ({ name: ref, value: ref })),
  });
}

async function listFragmentRefs(): Promise<string[]> {
  const refs = new Set<string>();
  await collectRefs(PATHS.builtInFragmentsDir, "", refs);
  await collectRefs(PATHS.localFragmentsDir, "", refs);
  return [...refs].sort();
}

async function collectRefs(dir: string, prefix: string, refs: Set<string>): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRefs(fullPath, nextPrefix, refs);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      refs.add(nextPrefix.replace(/\.md$/, ""));
    }
  }
}

async function promptLevel(): Promise<PatchLevel> {
  try {
    return await select<PatchLevel>({
      message: "Incorporation level:",
      choices: [
        { name: "Install-only — keep as an invokable skill/reference outside the profile", value: "install-only" },
        { name: "Reference — add when-to-use guidance, no full skill copy", value: "reference" },
        { name: "Adapted fragment — extract concise durable behavior", value: "adapted" },
        { name: "Embedded — edit persona/rule contract directly", value: "embedded" },
      ],
    });
  } catch (err) {
    handlePromptExit(err);
    throw err;
  }
}

function parseLevel(value?: string): PatchLevel | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["install-only", "install", "l0"].includes(normalized)) return "install-only";
  if (["reference", "ref", "l1"].includes(normalized)) return "reference";
  if (["adapted", "adapted-fragment", "fragment", "l2"].includes(normalized)) return "adapted";
  if (["embedded", "embed", "persona", "rule", "l3"].includes(normalized)) return "embedded";
  console.error(`Unknown patch level: ${value}`);
  process.exit(1);
}

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function handlePromptExit(err: unknown): void {
  if (isExitPromptError(err)) {
    console.log("\nAborted.");
    process.exit(0);
  }
}

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "ExitPromptError";
}
