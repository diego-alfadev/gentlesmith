#!/usr/bin/env bun
/**
 * gentlesmith add — apply a preset bundle on top of a local profile
 *
 * Usage:
 *   gentlesmith add                # list available presets
 *   gentlesmith add <preset>       # apply preset to a local profile
 *   gentlesmith preset list        # list available presets
 *   gentlesmith preset add <name>  # apply preset to a local profile
 *
 * Presets live in presets/*.yaml. Each declares `include` and/or `skills`
 * entries that get merged into a runtime-home local profile.
 * Idempotent: re-running shows "already applied" if nothing new.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { confirm, select } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import {
  ensureRuntimeState,
  listLocalProfiles,
  resolvePresetPath,
  resolveRuntimePaths,
} from "./runtime";

const PATHS = resolveRuntimePaths();

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
  const profileName = readFlag(args, "--profile");

  // No args → list available presets.
  if (!presetName) {
    await ensureRuntimeState(PATHS);
    await listPresets();
    return;
  }

  // Resolve preset file (guard against path traversal).
  if (presetName.includes("..") || presetName.includes("/")) {
    console.error(`Invalid preset name: ${presetName}`);
    process.exit(1);
  }
  await ensureRuntimeState(PATHS);
  const presetPath = resolvePresetPath(PATHS, presetName);
  if (!presetPath || !existsSync(presetPath)) {
    console.error(`Preset not found: ${presetName}`);
    console.error(`Available presets:`);
    await listPresets();
    process.exit(1);
  }

  const profilePath = await resolveProfileForPreset(profileName);

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

  const profileRelative = profilePath.replace(PATHS.runtimeHome + "/", "~/.gentlesmith/");
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
  console.log("Applied. Run `gentlesmith sync --apply` to render.");
}

export async function runPreset(args: string[]): Promise<void> {
  const [subcommand, name] = args;

  if (!subcommand || subcommand === "list") {
    await ensureRuntimeState(PATHS);
    await listPresets();
    return;
  }

  if (subcommand === "add") {
    if (!name) {
      console.error("Usage: gentlesmith preset add <preset>");
      process.exit(1);
    }
    await runAdd(args.slice(1));
    return;
  }

  console.error("Usage:");
  console.error("  gentlesmith preset list");
  console.error("  gentlesmith preset add <preset> [--profile <profile>]");
  process.exit(1);
}

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function resolveProfileForPreset(profileName?: string): Promise<string> {
  const profiles = await listLocalProfiles(PATHS);
  if (profiles.length === 0) {
    console.error("No local profile found. Run `gentlesmith init` first.");
    process.exit(1);
  }

  if (profileName) {
    const match = profiles.find((profile) => profile.name === profileName);
    if (!match) {
      console.error(`Local profile not found: ${profileName}`);
      console.error("Available local profiles:");
      for (const profile of profiles) console.error(`  ${profile.name}`);
      process.exit(1);
    }
    return match.path;
  }

  if (profiles.length === 1) return profiles[0].path;

  try {
    return await select({
      message: "Which local profile should receive this preset?",
      choices: profiles.map((profile) => ({ name: profile.name, value: profile.path })),
    });
  } catch (err) {
    if (isExitPromptError(err)) {
      console.log("\nAborted.");
      process.exit(0);
    }
    throw err;
  }
}

async function listPresets(): Promise<void> {
  const localFiles = existsSync(PATHS.localPresetsDir)
    ? (await readdir(PATHS.localPresetsDir)).filter((f) => f.endsWith(".yaml"))
    : [];
  const builtInFiles = existsSync(PATHS.builtInPresetsDir)
    ? (await readdir(PATHS.builtInPresetsDir)).filter((f) => f.endsWith(".yaml") && !f.startsWith("local-"))
    : [];
  const files = Array.from(new Set([...builtInFiles, ...localFiles])).sort();
  if (files.length === 0) {
    console.log("No presets available.");
    return;
  }
  for (const f of files) {
    const path = resolvePresetPath(PATHS, f.replace(/\.yaml$/, ""));
    if (!path) continue;
    const preset = parseYAML(await readFile(path, "utf8")) as PresetSpec;
    const name = f.replace(/\.yaml$/, "");
    console.log(`  ${name.padEnd(20)} ${preset.description ?? ""}`);
  }
}

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ExitPromptError"
  );
}
