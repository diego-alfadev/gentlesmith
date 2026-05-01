#!/usr/bin/env bun
/**
 * gentlesmith browse — interactive TUI for exploring and managing profiles
 *
 * Browse fragments, profiles, targets. Inspect what a profile contains.
 * Create or edit profiles by toggling fragments on/off.
 * Scaffold new fragments and open them in $EDITOR.
 *
 * Invoked via `gentlesmith browse` — dispatched from distribute.ts.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
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
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
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
  path: string;
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
    const fullPath = localPath ?? repoFragments.get(ref)!;
    const source: "repo" | "local" = localPath ? "local" : "repo";
    const heading = await extractHeading(fullPath);
    const category = ref.includes("/") ? ref.split("/")[0] : "other";
    results.push({ ref, heading, source, category, path: fullPath });
  }
  return results;
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
  const lines = body.split("\n").length;
  const headingMatch = /^#\s+(.+)/m.exec(body);
  const heading = headingMatch ? headingMatch[1].trim() : "(no heading)";

  // First non-heading, non-empty paragraph.
  const paragraphs = body.split(/\n\n+/).filter((p) => !p.startsWith("#") && p.trim().length > 0);
  let firstParagraph = paragraphs[0]?.trim() ?? "";
  if (firstParagraph.length > 120) firstParagraph = firstParagraph.slice(0, 117) + "...";

  return { heading, lines, firstParagraph };
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

function resolveFragmentPath(ref: string): string {
  const localPath = join(FRAGMENTS_LOCAL_DIR, `${ref}.md`);
  if (existsSync(localPath)) return localPath;
  return join(FRAGMENTS_DIR, `${ref}.md`);
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

  const action = await select({
    message: "Next?",
    choices: [
      { name: "Inspect a fragment", value: "inspect" },
      { name: "Open a fragment in $EDITOR", value: "open" },
      { name: "Back to menu", value: "back" },
    ],
  });

  if (action === "inspect") await inspectFragment(fragments);
  else if (action === "open") await openFragment(fragments);
}

async function inspectFragment(fragments?: FragmentInfo[]) {
  if (!fragments) fragments = await discoverFragments();
  banner("Inspect Fragment");

  const ref = await select({
    message: "Which fragment?",
    choices: fragments.map((f) => ({
      name: `${f.ref}  ${c.dim("—")}  ${f.heading}${f.source === "local" ? c.yellow(" (local)") : ""}`,
      value: f.ref,
    })),
  });

  const frag = fragments.find((f) => f.ref === ref)!;
  const raw = await readFile(frag.path, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

  // Show which profiles use this fragment.
  const profiles = await loadProfiles();
  const usedBy = profiles.filter((p) => p.include.includes(ref));

  banner(`Fragment: ${ref}`);
  console.log(`  ${c.bold(frag.heading)}`);
  console.log(`  ${c.dim(`source: ${frag.source}  |  ${body.split("\n").length} lines  |  ${frag.path}`)}`);
  if (usedBy.length > 0) {
    console.log(`  ${c.dim("used by:")} ${usedBy.map((p) => c.cyan(p.name)).join(", ")}`);
  } else {
    console.log(`  ${c.yellow("not used by any profile")}`);
  }
  console.log(`\n  ${LINE}\n`);

  // Show content preview (first 25 lines of body).
  const previewLines = body.split("\n").slice(0, 25);
  for (const line of previewLines) {
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

  for (const p of profiles) {
    const tag = p.isLocal ? c.yellow(" (local)") : c.dim(" (bundled)");
    const count = `${p.include.length} fragments`;
    console.log(`  ${c.bold(p.name)}${tag}  ${c.dim(`— ${count}`)}`);
  }

  console.log("");

  const action = await select({
    message: "Next?",
    choices: [
      { name: "Inspect a profile (see what it contains)", value: "detail" },
      { name: "Back to menu", value: "back" },
    ],
  });

  if (action === "detail") await profileDetail();
}

async function profileDetail(preselected?: string) {
  const profiles = await loadProfiles();

  const profileName = preselected ?? await select({
    message: "Which profile?",
    choices: profiles.map((p) => ({
      name: `${p.name}  ${c.dim(`(${p.include.length} fragments)`)}`,
      value: p.name,
    })),
  });

  const profile = profiles.find((p) => p.name === profileName);
  if (!profile) return;

  banner(`Profile: ${profile.name}`);

  const tag = profile.isLocal ? c.yellow("local") : c.dim("bundled");
  console.log(`  ${c.bold(profile.name)}  ${c.dim("(")}${tag}${c.dim(")")}`);
  if (profile.description) console.log(`  ${c.dim(profile.description)}`);
  console.log("");

  // Resolve which targets use this profile.
  const targets = await loadTargets();
  const usedByTargets = targets.filter((t) => t.profile === profile.name);
  if (usedByTargets.length > 0) {
    console.log(`  ${c.underline("Rendered to:")}`);
    for (const t of usedByTargets) {
      console.log(`    ${c.cyan(t.name)}  →  ${t.destination}  ${c.dim(`(${t.mode})`)}`);
    }
    console.log("");
  }

  // Show each fragment with summary.
  console.log(`  ${c.underline("Fragments included:")}\n`);

  if (profile.include.length === 0) {
    console.log(`    ${c.dim("(empty profile)")}\n`);
  } else {
    let lastCat = "";
    for (const ref of profile.include) {
      const cat = ref.includes("/") ? ref.split("/")[0] : "other";
      if (cat !== lastCat) {
        if (lastCat) console.log("");
        console.log(`    ${c.bold(cat.toUpperCase())}`);
        lastCat = cat;
      }

      const fragPath = resolveFragmentPath(ref);
      if (!existsSync(fragPath)) {
        console.log(`      ${c.red("✗")} ${ref}  ${c.red("— missing!")}`);
        continue;
      }

      const isLocal = existsSync(join(FRAGMENTS_LOCAL_DIR, `${ref}.md`));
      const summary = await extractSummary(fragPath);
      const localTag = isLocal ? c.yellow(" ◂local") : "";

      console.log(`      ${c.green("●")} ${c.cyan(ref)}${localTag}  ${c.dim(`(${summary.lines} lines)`)}`);
      if (summary.firstParagraph) {
        console.log(`        ${c.dim(summary.firstParagraph)}`);
      }
    }
  }

  if (profile.skills.length > 0) {
    console.log(`\n  ${c.underline("Skills declared:")}\n`);
    for (const s of profile.skills) {
      console.log(`    ${c.magenta("◆")} ${s}`);
    }
  }

  console.log("");
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

  const added = selected.filter((s) => !currentIncludes.includes(s));
  const removed = currentIncludes.filter((s) => !selected.includes(s));

  if (added.length === 0 && removed.length === 0) {
    console.log(`\n  ${c.dim("No changes.")}\n`);
    await pause();
    return;
  }

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

// ── Fragment management ──────────────────────────────────────────────────────

async function openFragment(fragments?: FragmentInfo[]) {
  if (!fragments) fragments = await discoverFragments();

  const ref = await select({
    message: "Which fragment to open?",
    choices: fragments.map((f) => ({
      name: `${f.ref}  ${c.dim("—")}  ${f.heading}${f.source === "local" ? c.yellow(" (local)") : ""}`,
      value: f.ref,
    })),
  });

  const frag = fragments.find((f) => f.ref === ref)!;
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  console.log(`\n  Opening ${c.cyan(ref)} in ${c.dim(editor)}...\n`);
  spawnSync(editor, [frag.path], { stdio: "inherit" });
}

async function scaffoldFragment() {
  banner("New Fragment");

  const categories = ["persona", "rules", "env"];
  const category = await select({
    message: "Category:",
    choices: [
      ...categories.map((cat) => ({ name: cat, value: cat })),
      { name: "other (type your own)", value: "_custom" },
    ],
  });

  const actualCategory = category === "_custom"
    ? (await input({ message: "Category name:", validate: (v) => v.trim().length > 0 || "Cannot be empty" })).trim().toLowerCase()
    : category;

  const name = (await input({
    message: "Fragment name (kebab-case):",
    validate: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v.trim()) || "Use kebab-case (e.g. my-rule)",
  })).trim();

  const ref = `${actualCategory}/${name}`;
  const heading = (await input({
    message: "Heading (shown in browse):",
    default: name.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
  })).trim();

  // Local or repo?
  const location = await select({
    message: "Where to create?",
    choices: [
      { name: `fragments-local/${ref}.md  ${c.dim("(personal, gitignored)")}`, value: "local" },
      { name: `fragments/${ref}.md  ${c.dim("(shared, committed)")}`, value: "repo" },
    ],
  });

  const dir = location === "local" ? FRAGMENTS_LOCAL_DIR : FRAGMENTS_DIR;
  const filePath = join(dir, `${ref}.md`);

  if (existsSync(filePath)) {
    console.log(`\n  ${c.yellow("Already exists:")} ${filePath}\n`);
    await pause();
    return;
  }

  const content = `# ${heading}\n\n`;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  console.log(`\n  ${c.green("✓")} Created ${c.cyan(ref)} at ${c.dim(filePath)}`);

  const openNow = await confirm({ message: `Open in $EDITOR?`, default: true });
  if (openNow) {
    const editor = process.env.EDITOR || process.env.VISUAL || "vi";
    spawnSync(editor, [filePath], { stdio: "inherit" });
  }

  console.log(`\n  ${c.dim("Add it to a profile via Edit or gentlesmith add.")}\n`);
  await pause();
}

// ── Render actions ───────────────────────────────────────────────────────────

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

    // Quick status line.
    const fragments = await discoverFragments();
    const profiles = await loadProfiles();
    const targets = await loadTargets();
    console.log(`  ${c.dim(`${fragments.length} fragments  ·  ${profiles.length} profiles  ·  ${targets.length} targets`)}\n`);

    let action: string;
    try {
      action = await select({
        message: "What do you want to do?",
        choices: [
          new Separator(c.dim("── explore ──")),
          { name: `${c.cyan("◉")} View fragments`, value: "fragments" },
          { name: `${c.cyan("◉")} View profiles`, value: "profiles" },
          { name: `${c.cyan("◉")} Inspect a profile`, value: "detail" },
          { name: `${c.cyan("◉")} View targets`, value: "targets" },
          new Separator(c.dim("── manage ──")),
          { name: `${c.green("✎")} Edit a profile`, value: "edit" },
          { name: `${c.green("+")} Create a profile`, value: "create" },
          { name: `${c.green("+")} New fragment`, value: "scaffold" },
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
        case "detail": await profileDetail(); break;
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

// ── Utils ────────────────────────────────────────────────────────────────────

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "ExitPromptError";
}
