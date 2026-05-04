#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { confirm, select } from "@inquirer/prompts";
import type { ExitPromptError as ExitPromptErrorType } from "@inquirer/core";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import {
  ensureRuntimeState,
  listLocalProfiles,
  resolveRuntimePaths,
} from "./runtime";
import { discoverRuntime } from "./discovery";

const PATHS = resolveRuntimePaths();

interface ProfileDoc {
  name?: string;
  include?: string[];
  skills?: string[];
  [key: string]: unknown;
}

export async function runSkills(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  await ensureRuntimeState(PATHS);

  switch (subcommand) {
    case undefined:
    case "discover":
      await listDiscoveredSkills();
      return;
    case "list":
      await listProfileSkills(readFlag(rest, "--profile"));
      return;
    case "add":
      await addSkill(rest);
      return;
    case "install":
      await installProfileSkills(readFlag(rest, "--profile"));
      return;
    case "find":
    case "search":
      findSkills(rest);
      return;
    default:
      usage();
  }
}

function usage(): never {
  console.log("Usage:");
  console.log("  gentlesmith skills discover");
  console.log("  gentlesmith skills list [--profile <profile>]");
  console.log("  gentlesmith skills add <package> [--profile <profile>] [--install]");
  console.log("  gentlesmith skills install [--profile <profile>]");
  console.log("  gentlesmith skills find <query>");
  process.exit(1);
}

async function listDiscoveredSkills(): Promise<void> {
  const snapshot = await discoverRuntime(PATHS);
  if (snapshot.skills.length === 0) {
    console.log("No installed skills detected in known roots.");
    console.log("Use gentle-ai or another skill builder/installer, then re-run discovery.");
    return;
  }

  let lastSource = "";
  for (const skill of snapshot.skills) {
    if (skill.source !== lastSource) {
      if (lastSource) console.log("");
      console.log(`${skill.source}:`);
      lastSource = skill.source;
    }
    console.log(`  - ${skill.name}  (${skill.path})`);
  }
}

async function listProfileSkills(profileName?: string): Promise<void> {
  const profiles = await listLocalProfiles(PATHS);
  if (profiles.length === 0) {
    console.log("No local profiles found. Run `gentlesmith init` first.");
    return;
  }

  const selected = profileName
    ? profiles.filter((profile) => profile.name === profileName)
    : profiles;

  if (selected.length === 0) {
    console.error(`Local profile not found: ${profileName}`);
    process.exit(1);
  }

  for (const profile of selected) {
    const doc = parseYAML(await readFile(profile.path, "utf8")) as ProfileDoc;
    console.log(`${profile.name}:`);
    const skills = doc.skills ?? [];
    if (skills.length === 0) {
      console.log("  (no skills declared)");
      continue;
    }
    for (const skill of skills) console.log(`  - ${skill}`);
  }
}

async function addSkill(args: string[]): Promise<void> {
  const packageName = args.find((arg) => !arg.startsWith("--") && arg !== readFlag(args, "--profile"));
  if (!packageName) usage();

  const profile = await resolveProfile(readFlag(args, "--profile"));
  const doc = parseYAML(await readFile(profile.path, "utf8")) as ProfileDoc;
  const current = doc.skills ?? [];

  if (current.includes(packageName)) {
    console.log(`Skill already declared in ${profile.name}: ${packageName}`);
  } else {
    doc.skills = [...current, packageName];
    console.log(`Will add skill to ${profile.name}: ${packageName}`);
    const ok = await askConfirm("Save profile change?", true);
    if (!ok) {
      console.log("Aborted — no changes.");
      return;
    }
    await writeFile(profile.path, stringifyYAML(doc), "utf8");
    console.log("Saved.");
  }

  if (args.includes("--install")) {
    installSkills([packageName]);
  }
}

async function installProfileSkills(profileName?: string): Promise<void> {
  const profile = await resolveProfile(profileName);
  const doc = parseYAML(await readFile(profile.path, "utf8")) as ProfileDoc;
  installSkills(doc.skills ?? []);
}

export function installSkills(skills: string[]): void {
  const unique = Array.from(new Set(skills.filter((skill) => skill.trim().length > 0)));
  if (unique.length === 0) {
    console.log("No skills declared.");
    return;
  }

  const probe = spawnSync("npx", ["--yes", "skills", "--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.warn("WARNING: `npx skills` not available — skipping skills install.");
    console.warn("Install/use skills via https://skills.sh when available.");
    return;
  }

  for (const skill of unique) {
    console.log(`installing skill globally: ${skill}`);
    const result = spawnSync("npx", ["--yes", "skills", "add", "-g", skill], { stdio: "inherit" });
    if (result.status !== 0) console.warn(`WARNING: failed to install ${skill} (continuing).`);
  }
}

function findSkills(args: string[]): void {
  if (args.length === 0) usage();
  const result = spawnSync("npx", ["--yes", "skills", "find", ...args], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.warn("WARNING: skills search failed. Check https://skills.sh.");
  }
}

async function resolveProfile(profileName?: string): Promise<{ name: string; path: string }> {
  const profiles = await listLocalProfiles(PATHS);
  if (profiles.length === 0) {
    console.error("No local profiles found. Run `gentlesmith init` first.");
    process.exit(1);
  }

  if (profileName) {
    const match = profiles.find((profile) => profile.name === profileName);
    if (!match) {
      console.error(`Local profile not found: ${profileName}`);
      process.exit(1);
    }
    return match;
  }

  if (profiles.length === 1) return profiles[0];

  try {
    const path = await select({
      message: "Which local profile?",
      choices: profiles.map((profile) => ({ name: profile.name, value: profile.path })),
    });
    return profiles.find((profile) => profile.path === path)!;
  } catch (err) {
    if (isExitPromptError(err)) {
      console.log("\nAborted.");
      process.exit(0);
    }
    throw err;
  }
}

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function askConfirm(message: string, defaultValue: boolean): Promise<boolean> {
  try {
    return await confirm({ message, default: defaultValue });
  } catch (err) {
    if (isExitPromptError(err)) {
      console.log("\nAborted.");
      process.exit(0);
    }
    throw err;
  }
}

function isExitPromptError(err: unknown): err is ExitPromptErrorType {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ExitPromptError"
  );
}
