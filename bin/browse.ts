#!/usr/bin/env bun
/**
 * gentlesmith browse — interactive TUI for exploring and managing profiles
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkbox, confirm, input, select, Separator } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import {
  PACKAGE_ROOT,
  ensureRuntimeState,
  listBuiltInProfiles,
  listInstalledTargets,
  listLocalProfiles,
  resolveFragmentPath as resolveRuntimeFragmentPath,
  resolveRuntimePaths,
} from "./runtime";
import { discoverRuntime, summarizeDiscovery } from "./discovery";

const PATHS = resolveRuntimePaths();

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
};

const HEADER = `${c.bold("gentlesmith")} ${c.dim("browse")}`;
const LINE = c.dim("─".repeat(60));

interface FragmentInfo {
  ref: string;
  heading: string;
  source: "repo" | "local";
  category: string;
  path: string;
}

interface ProfileInfo {
  name: string;
  file: string;
  description: string;
  include: string[];
  skills: string[];
  isLocal: boolean;
}

interface TargetInfo {
  name: string;
  agent: string;
  profile: string;
  destination: string;
  mode: string;
  enabled: boolean;
}

function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function banner(section?: string) {
  clear();
  const title = section ? `${HEADER}  ${c.dim("›")}  ${c.cyan(section)}` : HEADER;
  console.log(`\n  ${title}\n  ${LINE}\n`);
}

async function pause() {
  await input({ message: c.dim("press enter to continue") });
}

function openPathInEditor(path: string, kind: "file" | "folder"): void {
  const code = spawnSync("which", ["code"], { stdio: "pipe" });
  if (code.status === 0) {
    spawnSync("code", [path], { stdio: "inherit" });
    return;
  }

  if (kind === "file") {
    const editor = process.env.EDITOR || process.env.VISUAL || "vi";
    spawnSync(editor, [path], { stdio: "inherit" });
    return;
  }

  if (process.platform === "darwin") {
    spawnSync("open", [path], { stdio: "inherit" });
    return;
  }

  console.log(`\n  No folder opener found. Open manually: ${path}\n`);
}

function openPathsInCode(paths: string[]): boolean {
  const code = spawnSync("which", ["code"], { stdio: "pipe" });
  if (code.status !== 0) return false;
  spawnSync("code", paths, { stdio: "inherit" });
  return true;
}

async function discoverFragments(): Promise<FragmentInfo[]> {
  const repoFragments = new Map<string, string>();
  const localFragments = new Map<string, string>();

  async function collectRefs(dir: string, prefix: string, map: Map<string, string>) {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("_")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectRefs(full, prefix ? `${prefix}/${entry.name}` : entry.name, map);
      } else if (entry.name.endsWith(".md")) {
        const ref = prefix ? `${prefix}/${entry.name.replace(/\.md$/, "")}` : entry.name.replace(/\.md$/, "");
        map.set(ref, full);
      }
    }
  }

  await collectRefs(PATHS.builtInFragmentsDir, "", repoFragments);
  await collectRefs(PATHS.localFragmentsDir, "", localFragments);

  const refs = new Set([...repoFragments.keys(), ...localFragments.keys()]);
  const out: FragmentInfo[] = [];
  for (const ref of [...refs].sort()) {
    const localPath = localFragments.get(ref);
    const fullPath = localPath ?? repoFragments.get(ref)!;
    out.push({
      ref,
      heading: await extractHeading(fullPath),
      source: localPath ? "local" : "repo",
      category: ref.includes("/") ? ref.split("/")[0] : "other",
      path: fullPath,
    });
  }
  return out;
}

async function extractHeading(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const match = /^#\s+(.+)/m.exec(body);
  return match ? match[1].trim() : "(no heading)";
}

async function extractSummary(path: string): Promise<{ heading: string; lines: number; firstParagraph: string }> {
  const raw = await readFile(path, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const heading = /^#\s+(.+)/m.exec(body)?.[1]?.trim() ?? "(no heading)";
  const lines = body.split("\n").length;
  const paragraphs = body.split(/\n\n+/).filter((p) => !p.startsWith("#") && p.trim().length > 0);
  let firstParagraph = paragraphs[0]?.trim() ?? "";
  if (firstParagraph.length > 120) firstParagraph = `${firstParagraph.slice(0, 117)}...`;
  return { heading, lines, firstParagraph };
}

async function loadProfiles(): Promise<ProfileInfo[]> {
  const out: ProfileInfo[] = [];

  for (const profile of await listBuiltInProfiles(PATHS)) {
    const raw = parseYAML(await readFile(profile.path, "utf8")) as Record<string, unknown>;
    out.push({
      name: (raw.name as string) ?? profile.name,
      file: profile.path,
      description: (raw.description as string) ?? "",
      include: Array.isArray(raw.include) ? raw.include as string[] : [],
      skills: Array.isArray(raw.skills) ? raw.skills as string[] : [],
      isLocal: false,
    });
  }

  for (const profile of await listLocalProfiles(PATHS)) {
    const raw = parseYAML(await readFile(profile.path, "utf8")) as Record<string, unknown>;
    out.push({
      name: (raw.name as string) ?? profile.name,
      file: profile.path,
      description: (raw.description as string) ?? "",
      include: Array.isArray(raw.include) ? raw.include as string[] : [],
      skills: Array.isArray(raw.skills) ? raw.skills as string[] : [],
      isLocal: true,
    });
  }

  return out;
}

async function loadTargets(): Promise<TargetInfo[]> {
  const installed = await listInstalledTargets(PATHS);
  return installed.map((target) => ({
    name: target.name,
    agent: target.spec.agent,
    profile: target.spec.profile,
    destination: target.spec.destination,
    mode: target.spec.mode,
    enabled: target.spec.enabled !== false,
  }));
}

function resolveFragmentPath(ref: string): string {
  return resolveRuntimeFragmentPath(PATHS, ref);
}

async function showFragments() {
  banner("Fragments");
  const fragments = await discoverFragments();
  const maxRef = Math.max(...fragments.map((f) => f.ref.length), 10);

  let lastCategory = "";
  for (const fragment of fragments) {
    if (fragment.category !== lastCategory) {
      if (lastCategory) console.log("");
      console.log(`  ${c.bold(fragment.category.toUpperCase())}`);
      lastCategory = fragment.category;
    }
    const tag = fragment.source === "local" ? c.yellow(" (local)") : "";
    console.log(`    ${c.cyan(fragment.ref.padEnd(maxRef + 2))} ${fragment.heading}${tag}`);
  }

  console.log(`\n  ${c.dim(`${fragments.length} fragments total`)}\n`);

  const action = await select({
    message: "Next?",
    choices: [
      { name: "Inspect a fragment", value: "inspect" },
      { name: "Open a fragment in editor", value: "open" },
      { name: "Back to menu", value: "back" },
    ],
  });

  if (action === "inspect") await inspectFragment(fragments);
  if (action === "open") await openFragment(fragments);
}

async function inspectFragment(fragments?: FragmentInfo[]) {
  const allFragments = fragments ?? await discoverFragments();
  banner("Inspect Fragment");

  const ref = await select({
    message: "Which fragment?",
    choices: allFragments.map((fragment) => ({
      name: `${fragment.ref}  ${c.dim("—")}  ${fragment.heading}${fragment.source === "local" ? c.yellow(" (local)") : ""}`,
      value: fragment.ref,
    })),
  });

  const fragment = allFragments.find((entry) => entry.ref === ref)!;
  const raw = await readFile(fragment.path, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const profiles = await loadProfiles();
  const usedBy = profiles.filter((profile) => profile.include.includes(ref));

  banner(`Fragment: ${ref}`);
  console.log(`  ${c.bold(fragment.heading)}`);
  console.log(`  ${c.dim(`source: ${fragment.source}  |  ${body.split("\n").length} lines  |  ${fragment.path}`)}`);
  if (usedBy.length > 0) console.log(`  ${c.dim("used by:")} ${usedBy.map((profile) => c.cyan(profile.name)).join(", ")}`);
  console.log(`\n  ${LINE}\n`);

  for (const line of body.split("\n").slice(0, 25)) {
    console.log(`  ${c.dim("│")} ${line}`);
  }
  if (body.split("\n").length > 25) {
    console.log(`  ${c.dim(`│ ... (${body.split("\n").length - 25} more lines)`)}`);
  }

  console.log("");
  await pause();
}

async function showProfiles() {
  banner("Profiles");
  const profiles = await loadProfiles();
  for (const profile of profiles) {
    const tag = profile.isLocal ? c.yellow(" (local)") : c.dim(" (bundled)");
    console.log(`  ${c.bold(profile.name)}${tag}  ${c.dim(`— ${profile.include.length} fragments`)}`);
  }

  console.log("");
  const action = await select({
    message: "Next?",
    choices: [
      { name: "Inspect a profile", value: "detail" },
      { name: "Open profile workspace", value: "open-profile" },
      { name: "Open profiles folder", value: "open-folder" },
      { name: "Back to menu", value: "back" },
    ],
  });

  if (action === "detail") await profileDetail();
  if (action === "open-profile") await openProfile();
  if (action === "open-folder") await openProfilesFolder();
}

async function profileDetail(preselected?: string) {
  const profiles = await loadProfiles();
  const profileName = preselected ?? await select({
    message: "Which profile?",
    choices: profiles.map((profile) => ({
      name: `${profile.name}  ${c.dim(`(${profile.include.length} fragments)`)}`,
      value: profile.name,
    })),
  });

  const profile = profiles.find((entry) => entry.name === profileName);
  if (!profile) return;

  banner(`Profile: ${profile.name}`);
  console.log(`  ${c.bold(profile.name)}  ${profile.isLocal ? c.yellow("(local)") : c.dim("(bundled)")}`);
  if (profile.description) console.log(`  ${c.dim(profile.description)}`);
  console.log("");

  const targets = await loadTargets();
  const usedByTargets = targets.filter((target) => target.profile === profile.name);
  if (usedByTargets.length > 0) {
    console.log(`  ${c.underline("Rendered to:")}`);
    for (const target of usedByTargets) {
      const status = target.enabled ? c.green("enabled") : c.yellow("disabled");
      console.log(`    ${c.cyan(target.name)}  →  ${target.destination}  ${c.dim(`(${target.mode})`)}  ${status}`);
    }
    console.log("");
  }

  console.log(`  ${c.underline("Fragments included:")}\n`);
  if (profile.include.length === 0) {
    console.log(`    ${c.dim("(empty profile)")}\n`);
  } else {
    let lastCategory = "";
    for (const ref of profile.include) {
      const category = ref.includes("/") ? ref.split("/")[0] : "other";
      if (category !== lastCategory) {
        if (lastCategory) console.log("");
        console.log(`    ${c.bold(category.toUpperCase())}`);
        lastCategory = category;
      }

      const fragmentPath = resolveFragmentPath(ref);
      if (!existsSync(fragmentPath)) {
        console.log(`      ${c.red("✗")} ${ref}  ${c.red("— missing!")}`);
        continue;
      }
      const summary = await extractSummary(fragmentPath);
      const isLocal = existsSync(join(PATHS.localFragmentsDir, `${ref}.md`));
      console.log(`      ${c.green("●")} ${c.cyan(ref)}${isLocal ? c.yellow(" ◂local") : ""}  ${c.dim(`(${summary.lines} lines)`)}`);
      if (summary.firstParagraph) console.log(`        ${c.dim(summary.firstParagraph)}`);
    }
  }

  if (profile.skills.length > 0) {
    console.log(`\n  ${c.underline("Skills declared:")}\n`);
    for (const skill of profile.skills) {
      console.log(`    ${c.magenta("◆")} ${skill}`);
    }
  }

  console.log("");
  const action = await select({
    message: "Next?",
    choices: [
      ...(profile.isLocal ? [{ name: "Open profile workspace", value: "open" }] : []),
      { name: "Back", value: "back" },
    ],
  });
  if (action === "open" && profile.isLocal) await openProfile(profile.file);
}

async function showTargets() {
  banner("Targets");
  const targets = await loadTargets();
  for (const target of targets) {
    const modeColor = target.mode === "per-fragment" ? c.magenta(target.mode) : c.green(target.mode);
    console.log(`  ${c.bold(target.name)}  ${target.enabled ? c.green("enabled") : c.yellow("disabled")}`);
    console.log(`    agent:    ${target.agent}`);
    console.log(`    profile:  ${target.profile}`);
    console.log(`    dest:     ${c.cyan(target.destination)}`);
    console.log(`    mode:     ${modeColor}`);
    console.log("");
  }

  console.log(`  ${c.dim(`${targets.length} targets installed`)}\n`);
  await pause();
}

async function showDiscovery() {
  banner("Discovery");
  const snapshot = await discoverRuntime(PATHS);
  for (const line of summarizeDiscovery(snapshot)) console.log(`  - ${line}`);
  console.log("");
  await pause();
}

async function showSkills() {
  banner("Skills");
  const snapshot = await discoverRuntime(PATHS);
  if (snapshot.skills.length === 0) {
    console.log("  No installed skills detected in known roots.");
    console.log("  Use gentle-ai or another skill builder/installer, then re-run discovery.\n");
    await pause();
    return;
  }

  let lastSource = "";
  for (const skill of snapshot.skills) {
    if (skill.source !== lastSource) {
      if (lastSource) console.log("");
      console.log(`  ${c.bold(skill.source.toUpperCase())}`);
      lastSource = skill.source;
    }
    console.log(`    ${c.magenta("◆")} ${skill.name}  ${c.dim(skill.path)}`);
  }
  console.log("");
  await pause();
}

async function editProfile() {
  banner("Edit Profile");
  const profiles = await loadProfiles();
  const localProfiles = profiles.filter((profile) => profile.isLocal);

  if (localProfiles.length === 0) {
    console.log(`  ${c.yellow("No local profiles found.")} Run ${c.cyan("gentlesmith init")} first.\n`);
    await pause();
    return;
  }

  const profilePath = await select({
    message: "Which profile to edit?",
    choices: localProfiles.map((profile) => ({
      name: `${profile.name}  ${c.dim(`(${profile.include.length} fragments)`)}`,
      value: profile.file,
    })),
  });

  const profileDoc = parseYAML(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  const currentIncludes = Array.isArray(profileDoc.include) ? profileDoc.include as string[] : [];
  const fragments = await discoverFragments();
  const categories = [...new Set(fragments.map((fragment) => fragment.category))];
  const choices: Array<{ name: string; value: string; checked: boolean } | Separator> = [];

  for (const category of categories) {
    choices.push(new Separator(c.dim(`── ${category} ──`)));
    for (const fragment of fragments.filter((entry) => entry.category === category)) {
      choices.push({
        name: `${fragment.ref}  ${c.dim("—")}  ${fragment.heading}${fragment.source === "local" ? c.yellow(" ◂local") : ""}`,
        value: fragment.ref,
        checked: currentIncludes.includes(fragment.ref),
      });
    }
  }

  banner("Edit Profile");
  console.log(`  Editing ${c.bold(profilePath.replace(`${PATHS.runtimeHome}/`, "~/.gentlesmith/"))}\n`);
  console.log(`  ${c.dim("Space = toggle, Enter = confirm, Ctrl-C = cancel")}\n`);

  const selected = await checkbox({ message: "Fragments:", choices });
  const added = selected.filter((item) => !currentIncludes.includes(item));
  const removed = currentIncludes.filter((item) => !selected.includes(item));

  if (added.length === 0 && removed.length === 0) {
    console.log(`\n  ${c.dim("No changes.")}\n`);
    await pause();
    return;
  }

  banner("Edit Profile — Review Changes");
  for (const ref of added) console.log(`  ${c.green("+ " + ref)}`);
  for (const ref of removed) console.log(`  ${c.red("- " + ref)}`);
  console.log("");

  const ok = await confirm({ message: "Save these changes?", default: true });
  if (!ok) return;

  profileDoc.include = selected;
  await writeFile(profilePath, stringifyYAML(profileDoc), "utf8");
  console.log(`\n  ${c.green("✓")} Saved. Run ${c.cyan("gentlesmith sync --apply")} to render.\n`);
  await pause();
}

async function createProfile() {
  banner("Create Profile");
  const rawHandle = await input({
    message: "Profile name:",
    validate: (value) => value.trim().length > 0 || "Cannot be empty",
  });

  const slug = rawHandle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const fileName = `local-${slug}.yaml`;
  const filePath = join(PATHS.localProfilesDir, fileName);

  if (existsSync(filePath)) {
    console.log(`\n  ${c.yellow(fileName)} already exists. Use ${c.cyan("Edit")} instead.\n`);
    await pause();
    return;
  }

  const fragments = await discoverFragments();
  const categories = [...new Set(fragments.map((fragment) => fragment.category))];
  const choices: Array<{ name: string; value: string; checked: boolean } | Separator> = [];
  for (const category of categories) {
    choices.push(new Separator(c.dim(`── ${category} ──`)));
    for (const fragment of fragments.filter((entry) => entry.category === category)) {
      choices.push({
        name: `${fragment.ref}  ${c.dim("—")}  ${fragment.heading}`,
        value: fragment.ref,
        checked: false,
      });
    }
  }

  const selected = await checkbox({ message: "Include:", choices });
  const profile = {
    name: `local-${slug}`,
    description: "Created via gentlesmith browse",
    include: selected,
  };

  await writeFile(filePath, stringifyYAML(profile), "utf8");
  console.log(`\n  ${c.green("✓")} Created ${c.cyan(fileName)} with ${selected.length} fragments.`);
  console.log(`  Run ${c.cyan("gentlesmith sync --apply")} to render.\n`);
  await pause();
}

async function openProfile(selectedPath?: string) {
  banner("Open Profile Workspace");
  const profiles = (await loadProfiles()).filter((profile) => profile.isLocal);
  if (profiles.length === 0) {
    console.log(`  ${c.yellow("No local profiles found.")}\n`);
    await pause();
    return;
  }

  const profilePath = selectedPath ?? await select({
      message: "Which profile workspace to open?",
      choices: profiles.map((profile) => ({
        name: `${profile.name}  ${c.dim(`(${profile.include.length} fragments)`)}`,
        value: profile.file,
      })),
    });

  const workspacePath = await writeProfileWorkspace(profilePath);
  const profile = parseYAML(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  const includes = Array.isArray(profile.include) ? profile.include.filter((x): x is string => typeof x === "string") : [];
  const fragmentPaths = includes
    .map((ref) => resolveFragmentPath(ref))
    .filter((path) => existsSync(path));

  if (!openPathsInCode([workspacePath, profilePath, ...fragmentPaths])) {
    console.log(`\n  VS Code CLI not found. Opening profile file instead.\n`);
    openPathInEditor(profilePath, "file");
  }
}

async function writeProfileWorkspace(profilePath: string): Promise<string> {
  const profileName = profilePath.split("/").pop()!.replace(/\.yaml$/, "");
  const workspaceDir = join(PATHS.runtimeHome, "workspaces");
  const workspacePath = join(workspaceDir, `${profileName}.code-workspace`);
  await mkdir(workspaceDir, { recursive: true });
  const snapshot = await discoverRuntime(PATHS);
  const skillRoots = Array.from(new Set(snapshot.skills.map((skill) => skill.root))).filter((root) => existsSync(root));

  const workspace = {
    folders: [
      { name: "profile", path: PATHS.localProfilesDir },
      { name: "local fragments", path: PATHS.localFragmentsDir },
      { name: "built-in fragments", path: PATHS.builtInFragmentsDir },
      ...skillRoots.map((root) => ({ name: `skills: ${root.split("/").slice(-2).join("/")}`, path: root })),
    ],
    settings: {
      "files.exclude": {
        "**/.DS_Store": true,
      },
    },
  };

  await writeFile(workspacePath, JSON.stringify(workspace, null, 2) + "\n", "utf8");
  return workspacePath;
}

async function openProfilesFolder() {
  banner("Open Profiles Folder");
  openPathInEditor(PATHS.localProfilesDir, "folder");
}

async function openFragment(fragments?: FragmentInfo[]) {
  const allFragments = fragments ?? await discoverFragments();
  const ref = await select({
    message: "Which fragment to open?",
    choices: allFragments.map((fragment) => ({
      name: `${fragment.ref}  ${c.dim("—")}  ${fragment.heading}${fragment.source === "local" ? c.yellow(" (local)") : ""}`,
      value: fragment.ref,
    })),
  });
  const fragment = allFragments.find((entry) => entry.ref === ref)!;
  console.log(`\n  Opening ${c.cyan(ref)}...\n`);
  openPathInEditor(fragment.path, "file");
}

async function scaffoldFragment() {
  banner("New Fragment");
  const category = await select({
    message: "Category:",
    choices: [
      { name: "persona", value: "persona" },
      { name: "rules", value: "rules" },
      { name: "env", value: "env" },
      { name: "other (type your own)", value: "_custom" },
    ],
  });

  const actualCategory = category === "_custom"
    ? (await input({ message: "Category name:", validate: (value) => value.trim().length > 0 || "Cannot be empty" })).trim().toLowerCase()
    : category;
  const name = (await input({
    message: "Fragment name (kebab-case):",
    validate: (value) => /^[a-z0-9][a-z0-9-]*$/.test(value.trim()) || "Use kebab-case (e.g. my-rule)",
  })).trim();
  const heading = (await input({
    message: "Heading (shown in browse):",
    default: name.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
  })).trim();

  const location = await select({
    message: "Where to create?",
    choices: [
      { name: `fragments-local/${actualCategory}/${name}.md  ${c.dim("(personal, runtime-home)")}`, value: "local" },
      { name: `fragments/${actualCategory}/${name}.md  ${c.dim("(shared, committed)")}`, value: "repo" },
    ],
  });

  const root = location === "local" ? PATHS.localFragmentsDir : PATHS.builtInFragmentsDir;
  const filePath = join(root, `${actualCategory}/${name}.md`);
  if (existsSync(filePath)) {
    console.log(`\n  ${c.yellow("Already exists:")} ${filePath}\n`);
    await pause();
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `# ${heading}\n\n`, "utf8");
  console.log(`\n  ${c.green("✓")} Created ${c.cyan(`${actualCategory}/${name}`)} at ${c.dim(filePath)}`);
  const openNow = await confirm({ message: "Open in editor?", default: true });
  if (openNow) openPathInEditor(filePath, "file");
  await pause();
}

async function dryRun() {
  banner("Dry-run");
  spawnSync("bun", [join(PACKAGE_ROOT, "bin/distribute.ts"), "sync"], { stdio: "inherit" });
  console.log("");
  await pause();
}

async function applyNow() {
  banner("Apply");
  const ok = await confirm({ message: "Write changes to all agent config files?", default: true });
  if (!ok) return;
  spawnSync("bun", [join(PACKAGE_ROOT, "bin/distribute.ts"), "sync", "--apply"], { stdio: "inherit" });
  console.log(`\n  ${c.green("✓")} Done.\n`);
  await pause();
}

async function forgeProfile() {
  banner("Forge");
  spawnSync("bun", [join(PACKAGE_ROOT, "bin/distribute.ts"), "forge"], { stdio: "inherit" });
  console.log("");
  await pause();
}

export async function runBrowse(): Promise<void> {
  await ensureRuntimeState(PATHS);
  while (true) {
    banner();
    const fragments = await discoverFragments();
    const profiles = await loadProfiles();
    const targets = await loadTargets();
    console.log(`  ${c.dim(`${fragments.length} fragments  ·  ${profiles.length} profiles  ·  ${targets.length} installed targets`)}\n`);

    let action: string;
    try {
      action = await select({
        message: "What do you want to do?",
        choices: [
          new Separator(c.dim("── explore ──")),
          { name: `${c.green("✦")} Forge profile`, value: "forge" },
          { name: `${c.cyan("◉")} Discovery snapshot`, value: "discovery" },
          { name: `${c.cyan("◉")} View fragments`, value: "fragments" },
          { name: `${c.cyan("◉")} View profiles`, value: "profiles" },
          { name: `${c.cyan("◉")} Inspect a profile`, value: "detail" },
          { name: `${c.cyan("◉")} View skills`, value: "skills" },
          { name: `${c.cyan("◉")} View installed targets`, value: "targets" },
          new Separator(c.dim("── manage ──")),
          { name: `${c.green("✎")} Edit a profile`, value: "edit" },
          { name: `${c.green("+")} Create a profile`, value: "create" },
          { name: `${c.green("+")} New fragment`, value: "scaffold" },
          new Separator(c.dim("── render ──")),
          { name: `${c.yellow("▶")} Dry-run sync`, value: "dryrun" },
          { name: `${c.magenta("▶")} Apply sync now`, value: "apply" },
          new Separator(""),
          { name: `${c.dim("exit")}`, value: "exit" },
        ],
      });
    } catch (err) {
      if (isExitPromptError(err)) break;
      throw err;
    }

    try {
      switch (action) {
        case "fragments": await showFragments(); break;
        case "forge": await forgeProfile(); break;
        case "discovery": await showDiscovery(); break;
        case "profiles": await showProfiles(); break;
        case "detail": await profileDetail(); break;
        case "skills": await showSkills(); break;
        case "targets": await showTargets(); break;
        case "edit": await editProfile(); break;
        case "create": await createProfile(); break;
        case "scaffold": await scaffoldFragment(); break;
        case "dryrun": await dryRun(); break;
        case "apply": await applyNow(); break;
        case "exit": clear(); return;
      }
    } catch (err) {
      if (isExitPromptError(err)) continue;
      throw err;
    }
  }
}

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "ExitPromptError";
}
