#!/usr/bin/env bun
/**
 * gentlesmith add — apply a preset bundle on top of a local profile
 *
 * Usage:
 *   gentlesmith add                # list available presets
 *   gentlesmith add <preset>       # apply preset to newest local profile
 *
 * Presets live in presets/*.yaml. Each declares `include` and/or `skills`
 * entries that get merged into the user's local profile (profiles/local-*.yaml).
 * Idempotent: re-running shows "already applied" if nothing new.
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const PROFILES_DIR = join(ROOT, "profiles");
const PRESETS_DIR = join(ROOT, "presets");

interface PresetSpec {
  description?: string;
  include?: string[];
  skills?: string[];
}

interface ProfileDoc {
  name?: string;
  description?: string;
  include?: string[];
  skills?: string[];
  [key: string]: unknown;
}

export async function runAdd(args: string[]): Promise<void> {
  const presetName = args[0];

  // No args → list available presets.
  if (!presetName) {
    await listPresets();
    return;
  }

  // Resolve preset file.
  const presetPath = join(PRESETS_DIR, `${presetName}.yaml`);
  if (!existsSync(presetPath)) {
    console.error(`Preset not found: ${presetName}`);
    console.error(`Available presets:`);
    await listPresets();
    process.exit(1);
  }

  // Find newest local profile.
  const profilePath = await findNewestLocalProfile();
  if (!profilePath) {
    console.error("No local profile found. Run `gentlesmith init` first.");
    process.exit(1);
  }

  const preset = parseYAML(await readFile(presetPath, "utf8")) as PresetSpec;
  const profile = parseYAML(await readFile(profilePath, "utf8")) as ProfileDoc;

  const currentIncludes = profile.include ?? [];
  const currentSkills = profile.skills ?? [];

  const newIncludes = (preset.include ?? []).filter((x) => !currentIncludes.includes(x));
  const newSkills = (preset.skills ?? []).filter((x) => !currentSkills.includes(x));

  if (newIncludes.length === 0 && newSkills.length === 0) {
    console.log(`'${presetName}' already applied — no changes.`);
    return;
  }

  const profileRelative = profilePath.replace(ROOT + "/", "");
  console.log(`Will add to ${profileRelative}:`);
  for (const i of newIncludes) console.log(`  + include: ${i}`);
  for (const s of newSkills) console.log(`  + skill:   ${s}`);

  let proceed: boolean;
  try {
    proceed = await confirm({ message: "Apply?", default: true });
  } catch (err) {
    if (isExitPromptError(err)) {
      console.log("\nAborted.");
      process.exit(0);
    }
    throw err;
  }

  if (!proceed) {
    console.log("Aborted — no changes.");
    return;
  }

  // Merge and write.
  profile.include = [...currentIncludes, ...newIncludes];
  if (newSkills.length > 0) {
    profile.skills = [...currentSkills, ...newSkills];
  }

  await writeFile(profilePath, stringifyYAML(profile), "utf8");
  console.log(`Applied. Run \`gentlesmith --apply\` to render.`);
}

async function listPresets(): Promise<void> {
  if (!existsSync(PRESETS_DIR)) {
    console.log("No presets directory found.");
    return;
  }
  const files = (await readdir(PRESETS_DIR)).filter(
    (f) => f.endsWith(".yaml") && !f.startsWith("local-"),
  );
  if (files.length === 0) {
    console.log("No presets available.");
    return;
  }
  for (const f of files) {
    const preset = parseYAML(await readFile(join(PRESETS_DIR, f), "utf8")) as PresetSpec;
    const name = f.replace(/\.yaml$/, "");
    console.log(`  ${name.padEnd(20)} ${preset.description ?? ""}`);
  }
}

async function findNewestLocalProfile(): Promise<string | null> {
  if (!existsSync(PROFILES_DIR)) return null;
  const files = (await readdir(PROFILES_DIR)).filter(
    (f) => f.startsWith("local-") && f.endsWith(".yaml"),
  );
  if (files.length === 0) return null;

  const withMtime = await Promise.all(
    files.map(async (f) => ({
      path: join(PROFILES_DIR, f),
      mtime: (await stat(join(PROFILES_DIR, f))).mtimeMs,
    })),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].path;
}

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ExitPromptError"
  );
}
