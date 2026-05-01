#!/usr/bin/env bun
/**
 * gentlesmith browse — interactive TUI for exploring and managing profiles
 *
 * Browse fragments, profiles, targets. Create or edit profiles by toggling
 * fragments on/off. Preview and apply from the menu.
 *
 * Invoked via `gentlesmith browse` — dispatched from distribute.ts.
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { select, checkbox, input, confirm } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const FRAGMENTS_DIR = join(ROOT, "fragments");
const FRAGMENTS_LOCAL_DIR = join(ROOT, "fragments-local");
const PROFILES_DIR = join(ROOT, "profiles");
const TARGETS_DIR = join(ROOT, "targets");

// ── Helpers ──────────────────────────────────────────────────────────────────

async function discoverFragments(): Promise<Array<{ ref: string; heading: string; source: "repo" | "local" }>> {
  const results: Array<{ ref: string; heading: string; source: "repo" | "local" }> = [];

  async function walk(dir: string, prefix: string, source: "repo" | "local") {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith("_")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, prefix ? `${prefix}/${e.name}` : e.name, source);
      } else if (e.name.endsWith(".md")) {
        const ref = prefix ? `${prefix}/${e.name.replace(/\.md$/, "")}` : e.name.replace(/\.md$/, "");
        const heading = await extractHeading(full);
        results.push({ ref, heading, source });
      }
    }
  }

  await walk(FRAGMENTS_DIR, "", "repo");
  // Local overrides: add if not already present as repo, or mark as local.
  const repoRefs = new Set(results.map((r) => r.ref));
  const localResults: typeof results = [];
  await walk(FRAGMENTS_LOCAL_DIR, "", "local");
  // walk pushed to results — filter: local fragments that override repo ones get source flipped.
  // Actually, we walked into `results` already. Let me redo this cleanly.

  // Reset and do it properly.
  results.length = 0;

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

  // Merge: local wins.
  const allRefs = new Set([...repoFragments.keys(), ...localFragments.keys()]);
  for (const ref of [...allRefs].sort()) {
    const localPath = localFragments.get(ref);
    const repoPath = repoFragments.get(ref);
    const path = localPath ?? repoPath!;
    const source: "repo" | "local" = localPath ? "local" : "repo";
    const heading = await extractHeading(path);
    results.push({ ref, heading, source });
  }

  return results;
}

async function extractHeading(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  // Skip frontmatter.
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
    const path = join(PROFILES_DIR, f);
    const raw = parseYAML(await readFile(path, "utf8")) as Record<string, unknown>;
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
  const fragments = await discoverFragments();
  const maxRef = Math.max(...fragments.map((f) => f.ref.length), 10);

  console.log("\n  Fragments available:\n");
  for (const f of fragments) {
    const tag = f.source === "local" ? " (local)" : "";
    console.log(`  ${f.ref.padEnd(maxRef + 2)} ${f.heading}${tag}`);
  }
  console.log("");
}

async function showProfiles() {
  const profiles = await loadProfiles();

  console.log("\n  Profiles:\n");
  for (const p of profiles) {
    const tag = p.isLocal ? " (local)" : "";
    console.log(`  ${p.name}${tag}`);
    if (p.description) console.log(`    ${p.description}`);
    console.log(`    includes: ${p.include.join(", ") || "(none)"}`);
    if (p.skills.length > 0) console.log(`    skills: ${p.skills.join(", ")}`);
    console.log("");
  }
}

async function showTargets() {
  const targets = await loadTargets();

  console.log("\n  Targets:\n");
  const maxName = Math.max(...targets.map((t) => t.name.length), 6);
  const maxMode = Math.max(...targets.map((t) => t.mode.length), 4);
  for (const t of targets) {
    console.log(`  ${t.name.padEnd(maxName + 2)} ${t.mode.padEnd(maxMode + 2)} → ${t.destination}  (profile: ${t.profile})`);
  }
  console.log("");
}

async function editProfile() {
  const profiles = await loadProfiles();
  const localProfiles = profiles.filter((p) => p.isLocal);

  if (localProfiles.length === 0) {
    console.log("\n  No local profiles found. Run `gentlesmith init` first.\n");
    return;
  }

  const profileName = await select({
    message: "Which profile to edit?",
    choices: localProfiles.map((p) => ({
      name: `${p.name} (${p.include.length} fragments)`,
      value: p.file,
    })),
  });

  const profilePath = join(PROFILES_DIR, profileName);
  const profile = parseYAML(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  const currentIncludes: string[] = Array.isArray(profile.include) ? profile.include : [];

  const fragments = await discoverFragments();

  const selected = await checkbox({
    message: "Toggle fragments (space to select, enter to confirm):",
    choices: fragments.map((f) => ({
      name: `${f.ref} — ${f.heading}${f.source === "local" ? " (local)" : ""}`,
      value: f.ref,
      checked: currentIncludes.includes(f.ref),
    })),
  });

  if (arraysEqual(selected, currentIncludes)) {
    console.log("\n  No changes.\n");
    return;
  }

  const added = selected.filter((s) => !currentIncludes.includes(s));
  const removed = currentIncludes.filter((s) => !selected.includes(s));

  if (added.length > 0) console.log(`  + ${added.join(", ")}`);
  if (removed.length > 0) console.log(`  - ${removed.join(", ")}`);

  const ok = await confirm({ message: "Save changes?", default: true });
  if (!ok) {
    console.log("  Aborted.\n");
    return;
  }

  profile.include = selected;
  await writeFile(profilePath, stringifyYAML(profile), "utf8");
  console.log(`  Saved. Run \`gentlesmith --apply\` to render.\n`);
}

async function createProfile() {
  const handle = await input({
    message: "Profile name (slug):",
    validate: (v) => v.trim().length > 0 || "Cannot be empty",
    transformer: (v) => v.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  });

  const slug = handle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const fileName = `local-${slug}.yaml`;
  const filePath = join(PROFILES_DIR, fileName);

  if (existsSync(filePath)) {
    console.log(`  Profile ${fileName} already exists. Use edit instead.\n`);
    return;
  }

  const fragments = await discoverFragments();
  const selected = await checkbox({
    message: "Select fragments to include:",
    choices: fragments.map((f) => ({
      name: `${f.ref} — ${f.heading}`,
      value: f.ref,
    })),
  });

  const profile = {
    name: `local-${slug}`,
    description: `Created via gentlesmith browse`,
    include: selected,
  };

  await writeFile(filePath, stringifyYAML(profile), "utf8");
  console.log(`\n  Created ${fileName} with ${selected.length} fragments.`);
  console.log(`  Run \`gentlesmith --apply\` to render.\n`);
}

async function dryRun() {
  console.log("");
  spawnSync("bun", [join(ROOT, "bin/distribute.ts")], { stdio: "inherit" });
  console.log("");
}

async function applyNow() {
  const ok = await confirm({ message: "Apply changes to all targets?", default: true });
  if (!ok) return;
  console.log("");
  spawnSync("bun", [join(ROOT, "bin/distribute.ts"), "--apply"], { stdio: "inherit" });
  console.log("");
}

// ── Main loop ────────────────────────────────────────────────────────────────

export async function runBrowse(): Promise<void> {
  console.log("gentlesmith browse — interactive explorer\n");

  while (true) {
    let action: string;
    try {
      action = await select({
        message: "What do you want to do?",
        choices: [
          { name: "View fragments", value: "fragments" },
          { name: "View profiles", value: "profiles" },
          { name: "View targets", value: "targets" },
          { name: "Edit a profile (toggle fragments)", value: "edit" },
          { name: "Create a new profile", value: "create" },
          { name: "Dry-run (preview changes)", value: "dryrun" },
          { name: "Apply now", value: "apply" },
          { name: "Exit", value: "exit" },
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
        case "exit": return;
      }
    } catch (err) {
      if (isExitPromptError(err)) continue;
      throw err;
    }
  }
}

// ── Utils ────────────────────────────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "ExitPromptError";
}
