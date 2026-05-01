#!/usr/bin/env bun
/**
 * gentlesmith browse — interactive TUI for exploring and managing profiles
 *
 * Browse fragments, profiles, targets. Create or edit profiles by toggling
 * fragments on/off. Preview and apply from the menu.
 *
 * Invoked via `gentlesmith browse` — dispatched from distribute.ts.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { select, checkbox, input, confirm, Separator } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const FRAGMENTS_DIR = join(ROOT, "fragments");
const FRAGMENTS_LOCAL_DIR = join(ROOT, "fragments-local");
const PROFILES_DIR = join(ROOT, "profiles");
const TARGETS_DIR = join(ROOT, "targets");

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const HEADER = `${c.bold("gentlesmith")} ${c.dim("browse")}`;
const LINE = c.dim("─".repeat(60));

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

// ── Data loaders ─────────────────────────────────────────────────────────────

interface FragmentInfo {
  ref: string;
  heading: string;
  source: "repo" | "local";
  category: string;
}

async function discoverFragments(): Promise<FragmentInfo[]> {
  const repoFragments = new Map<string, string>();
  const localFragments = new Map<string, string>();

  async function collectRefs(dir: string, prefix: string, map: Map<string, string>) {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith("_")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await collectRefs(full, prefix ? `${prefix}/${e.name}` : e.name, map);
      } else if (e.name.endsWith(".md")) {
        const ref = prefix ? `${prefix}/${e.name.replace(/\.md$/, "")}` : e.name.replace(/\.md$/, "");
        map.set(ref, full);
      }
    }
  }

  await collectRefs(FRAGMENTS_DIR, "", repoFragments);
  await collectRefs(FRAGMENTS_LOCAL_DIR, "", localFragments);

  const allRefs = new Set([...repoFragments.keys(), ...localFragments.keys()]);
  const results: FragmentInfo[] = [];
  for (const ref of [...allRefs].sort()) {
    const localPath = localFragments.get(ref);
    const path = localPath ?? repoFragments.get(ref)!;
    const source: "repo" | "local" = localPath ? "local" : "repo";
    const heading = await extractHeading(path);
    const category = ref.includes("/") ? ref.split("/")[0] : "other";
    results.push({ ref, heading, source, category });
  }
  return results;
}

async function extractHeading(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const match = /^#\s+(.+)/m.exec(body);
  return match ? match[1].trim() : "(no heading)";
}

interface ProfileInfo {
  name: string;
  file: string;
  description: string;
  include: string[];
  skills: string[];
  isLocal: boolean;
}

async function loadProfiles(): Promise<ProfileInfo[]> {
  const files = (await readdir(PROFILES_DIR)).filter((f) => f.endsWith(".yaml"));
  const profiles: ProfileInfo[] = [];
  for (const f of files) {
    const raw = parseYAML(await readFile(join(PROFILES_DIR, f), "utf8")) as Record<string, unknown>;
    profiles.push({
      name: (raw.name as string) ?? f.replace(/\.yaml$/, ""),
      file: f,
      description: (raw.description as string) ?? "",
      include: Array.isArray(raw.include) ? raw.include : [],
      skills: Array.isArray(raw.skills) ? raw.skills : [],
      isLocal: f.startsWith("local-"),
    });
  }
  return profiles;
}

interface TargetInfo {
  name: string;
  agent: string;
  profile: string;
  destination: string;
  mode: string;
}

async function loadTargets(): Promise<TargetInfo[]> {
  const files = (await readdir(TARGETS_DIR)).filter((f) => f.endsWith(".yaml"));
  const targets: TargetInfo[] = [];
  for (const f of files) {
    const raw = parseYAML(await readFile(join(TARGETS_DIR, f), "utf8")) as Record<string, unknown>;
    targets.push({
      name: f.replace(/\.yaml$/, ""),
      agent: (raw.agent as string) ?? "?",
      profile: (raw.profile as string) ?? "?",
      destination: (raw.destination as string) ?? "?",
      mode: (raw.mode as string) ?? "?",
    });
  }
  return targets;
}

// ── Screens ──────────────────────────────────────────────────────────────────

async function showFragments() {
  banner("Fragments");
  const fragments = await discoverFragments();
  const maxRef = Math.max(...fragments.map((f) => f.ref.length), 10);

  let lastCategory = "";
  for (const f of fragments) {
    if (f.category !== lastCategory) {
      if (lastCategory) console.log("");
      console.log(`  ${c.bold(f.category.toUpperCase())}`);
      lastCategory = f.category;
    }
    const tag = f.source === "local" ? c.yellow(" (local)") : "";
    console.log(`    ${c.cyan(f.ref.padEnd(maxRef + 2))} ${f.heading}${tag}`);
  }

  console.log(`\n  ${c.dim(`${fragments.length} fragments total`)}\n`);
  await pause();
}

async function showProfiles() {
  banner("Profiles");
  const profiles = await loadProfiles();

  for (const p of profiles) {
    const tag = p.isLocal ? c.yellow(" (local)") : c.dim(" (bundled)");
    console.log(`  ${c.bold(p.name)}${tag}`);
    if (p.description) console.log(`  ${c.dim(p.description)}`);
    console.log("");

    if (p.include.length > 0) {
      for (const ref of p.include) {
        console.log(`    ${c.green("●")} ${ref}`);
      }
    } else {
      console.log(`    ${c.dim("(no fragments)")}`);
    }

    if (p.skills.length > 0) {
      console.log("");
      for (const s of p.skills) {
        console.log(`    ${c.magenta("◆")} ${s}`);
      }
    }
    console.log(`\n  ${LINE}\n`);
  }
  await pause();
}

async function showTargets() {
  banner("Targets");
  const targets = await loadTargets();

  for (const t of targets) {
    const modeColor = t.mode === "per-fragment" ? c.magenta(t.mode) : c.green(t.mode);
    console.log(`  ${c.bold(t.name)}`);
    console.log(`    agent:    ${t.agent}`);
    console.log(`    profile:  ${t.profile}`);
    console.log(`    dest:     ${c.cyan(t.destination)}`);
    console.log(`    mode:     ${modeColor}`);
    console.log("");
  }

  console.log(`  ${c.dim(`${targets.length} targets configured`)}\n`);
  await pause();
}

async function editProfile() {
  banner("Edit Profile");
  const profiles = await loadProfiles();
  const localProfiles = profiles.filter((p) => p.isLocal);

  if (localProfiles.length === 0) {
    console.log(`  ${c.yellow("No local profiles found.")} Run ${c.cyan("gentlesmith init")} first.\n`);
    await pause();
    return;
  }

  const profileFile = await select({
    message: "Which profile to edit?",
    choices: localProfiles.map((p) => ({
      name: `${p.name}  ${c.dim(`(${p.include.length} fragments)`)}`,
      value: p.file,
    })),
  });

  const profilePath = join(PROFILES_DIR, profileFile);
  const profileDoc = parseYAML(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  const currentIncludes: string[] = Array.isArray(profileDoc.include) ? profileDoc.include : [];

  const fragments = await discoverFragments();

  // Group by category for a cleaner checkbox UI.
  const categories = [...new Set(fragments.map((f) => f.category))];
  const choices: Array<{ name: string; value: string; checked: boolean } | Separator> = [];
  for (const cat of categories) {
    choices.push(new Separator(c.dim(`── ${cat} ──`)));
    for (const f of fragments.filter((fr) => fr.category === cat)) {
      const tag = f.source === "local" ? c.yellow(" ◂local") : "";
      const active = currentIncludes.includes(f.ref);
      choices.push({
        name: `${f.ref}  ${c.dim("—")}  ${f.heading}${tag}`,
        value: f.ref,
        checked: active,
      });
    }
  }

  banner("Edit Profile");
  console.log(`  Editing ${c.bold(profileFile)}\n`);
  console.log(`  ${c.dim("Space = toggle, Enter = confirm, Ctrl-C = cancel")}\n`);

  const selected = await checkbox({ message: "Fragments:", choices });

  // Compute diff.
  const added = selected.filter((s) => !currentIncludes.includes(s));
  const removed = currentIncludes.filter((s) => !selected.includes(s));

  if (added.length === 0 && removed.length === 0) {
    console.log(`\n  ${c.dim("No changes.")}\n`);
    await pause();
    return;
  }

  // Show diff.
  banner("Edit Profile — Review Changes");
  console.log(`  Profile: ${c.bold(profileFile)}\n`);
  for (const a of added) console.log(`  ${c.green("+ " + a)}`);
  for (const r of removed) console.log(`  ${c.red("- " + r)}`);
  console.log("");

  const ok = await confirm({ message: "Save these changes?", default: true });
  if (!ok) {
    console.log(`  ${c.dim("Cancelled.")}\n`);
    return;
  }

  profileDoc.include = selected;
  await writeFile(profilePath, stringifyYAML(profileDoc), "utf8");
  console.log(`\n  ${c.green("✓")} Saved. Run ${c.cyan("gentlesmith --apply")} to render.\n`);
  await pause();
}

async function createProfile() {
  banner("Create Profile");

  const rawHandle = await input({
    message: "Profile name:",
    validate: (v) => v.trim().length > 0 || "Cannot be empty",
  });

  const slug = rawHandle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const fileName = `local-${slug}.yaml`;
  const filePath = join(PROFILES_DIR, fileName);

  if (existsSync(filePath)) {
    console.log(`\n  ${c.yellow(fileName)} already exists. Use ${c.cyan("Edit")} instead.\n`);
    await pause();
    return;
  }

  const fragments = await discoverFragments();
  const categories = [...new Set(fragments.map((f) => f.category))];
  const choices: Array<{ name: string; value: string; checked: boolean } | Separator> = [];
  for (const cat of categories) {
    choices.push(new Separator(c.dim(`── ${cat} ──`)));
    for (const f of fragments.filter((fr) => fr.category === cat)) {
      choices.push({
        name: `${f.ref}  ${c.dim("—")}  ${f.heading}`,
        value: f.ref,
        checked: false,
      });
    }
  }

  console.log(`\n  ${c.dim("Select fragments for")} ${c.bold(fileName)}\n`);
  const selected = await checkbox({ message: "Include:", choices });

  // Preview.
  banner("Create Profile — Preview");
  console.log(`  ${c.bold(fileName)}\n`);
  if (selected.length === 0) {
    console.log(`  ${c.dim("(empty profile)")}`);
  } else {
    for (const s of selected) console.log(`  ${c.green("●")} ${s}`);
  }
  console.log("");

  const ok = await confirm({ message: `Create ${fileName}?`, default: true });
  if (!ok) {
    console.log(`  ${c.dim("Cancelled.")}\n`);
    return;
  }

  const profile = {
    name: `local-${slug}`,
    description: "Created via gentlesmith browse",
    include: selected,
  };

  await writeFile(filePath, stringifyYAML(profile), "utf8");
  console.log(`\n  ${c.green("✓")} Created ${c.cyan(fileName)} with ${selected.length} fragments.`);
  console.log(`  Run ${c.cyan("gentlesmith --apply")} to render.\n`);
  await pause();
}

async function dryRun() {
  banner("Dry-run");
  spawnSync("bun", [join(ROOT, "bin/distribute.ts")], { stdio: "inherit" });
  console.log("");
  await pause();
}

async function applyNow() {
  banner("Apply");
  const ok = await confirm({ message: "Write changes to all agent config files?", default: true });
  if (!ok) return;
  console.log("");
  spawnSync("bun", [join(ROOT, "bin/distribute.ts"), "--apply"], { stdio: "inherit" });
  console.log(`\n  ${c.green("✓")} Done.\n`);
  await pause();
}

// ── Main loop ────────────────────────────────────────────────────────────────

export async function runBrowse(): Promise<void> {
  while (true) {
    banner();

    let action: string;
    try {
      action = await select({
        message: "What do you want to do?",
        choices: [
          new Separator(c.dim("── explore ──")),
          { name: `${c.cyan("◉")} View fragments`, value: "fragments" },
          { name: `${c.cyan("◉")} View profiles`, value: "profiles" },
          { name: `${c.cyan("◉")} View targets`, value: "targets" },
          new Separator(c.dim("── manage ──")),
          { name: `${c.green("✎")} Edit a profile`, value: "edit" },
          { name: `${c.green("+")} Create a profile`, value: "create" },
          new Separator(c.dim("── render ──")),
          { name: `${c.yellow("▶")} Dry-run (preview)`, value: "dryrun" },
          { name: `${c.magenta("▶")} Apply now`, value: "apply" },
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
        case "profiles": await showProfiles(); break;
        case "targets": await showTargets(); break;
        case "edit": await editProfile(); break;
        case "create": await createProfile(); break;
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

// ── Utils ────────────────────────────────────────────────────────────────────

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "ExitPromptError";
}
