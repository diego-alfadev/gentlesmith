#!/usr/bin/env bun

import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCK_RE,
  FRAGMENT_MARKER_PREFIX,
  cloneTemplateTarget,
  listInstalledTargets,
  listTargetTemplates,
  loadProfile,
  loadInstalledTarget,
  resolveRuntimePaths,
  resolveUserPath,
  saveInstalledTarget,
  stripManagedBlock,
  ensureRuntimeState,
  removeInstalledTarget,
  type TargetSpec,
} from "./runtime";
import { purgeOpenCodeProfileAgent } from "./opencode";

function usage(): never {
  console.log("Usage:");
  console.log("  gentlesmith target list");
  console.log("  gentlesmith target add <template>");
  console.log("  gentlesmith target set-profile <name> <profile>");
  console.log("  gentlesmith target enable <name>");
  console.log("  gentlesmith target disable <name>");
  console.log("  gentlesmith target remove <name>");
  console.log("  gentlesmith target purge <name>");
  process.exit(1);
}

async function listTargets(): Promise<void> {
  const paths = resolveRuntimePaths();
  await ensureRuntimeState(paths);
  const templates = await listTargetTemplates(paths);
  const installed = new Map((await listInstalledTargets(paths)).map((target) => [target.name, target]));

  for (const template of templates) {
    const current = installed.get(template.name);
    const status = current ? (current.spec.enabled === false ? "installed, disabled" : "installed, enabled") : "template only";
    console.log(`${template.name.padEnd(18)} ${status}`);
    console.log(`  agent: ${template.spec.agent}`);
    console.log(`  profile: ${current?.spec.profile ?? template.spec.profile}`);
    console.log(`  dest: ${current?.spec.destination ?? template.spec.destination}`);
    console.log(`  mode: ${current?.spec.mode ?? template.spec.mode}`);
  }

  for (const [name, current] of installed) {
    if (templates.some((template) => template.name === name)) continue;
    const status = current.spec.enabled === false ? "installed, disabled" : "installed, enabled";
    console.log(`${name.padEnd(18)} ${status} (custom)`);
    console.log(`  agent: ${current.spec.agent}`);
    console.log(`  profile: ${current.spec.profile}`);
    console.log(`  dest: ${current.spec.destination}`);
    console.log(`  mode: ${current.spec.mode}`);
  }
}

async function addTarget(templateName?: string): Promise<void> {
  if (!templateName) usage();
  const paths = resolveRuntimePaths();
  await ensureRuntimeState(paths);

  const installed = await loadInstalledTarget(paths, templateName);
  if (installed) {
    console.log(`Target already installed: ${templateName}`);
    return;
  }

  const spec = await cloneTemplateTarget(paths, templateName);
  await saveInstalledTarget(paths, templateName, spec);
  console.log(`Installed target: ${templateName}`);
}

async function setTargetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
  if (!name) usage();
  const paths = resolveRuntimePaths();
  await ensureRuntimeState(paths);
  const installed = await loadInstalledTarget(paths, name);
  if (!installed) {
    console.error(`Target not installed: ${name}`);
    process.exit(1);
  }

  const updated: TargetSpec = { ...installed.spec, enabled };
  await saveInstalledTarget(paths, name, updated);
  console.log(`${enabled ? "Enabled" : "Disabled"} target: ${name}`);
}

async function setTargetProfile(name: string | undefined, profileName: string | undefined): Promise<void> {
  if (!name || !profileName) usage();
  const paths = resolveRuntimePaths();
  await ensureRuntimeState(paths);
  const installed = await loadInstalledTarget(paths, name);
  if (!installed) {
    console.error(`Target not installed: ${name}`);
    process.exit(1);
  }

  try {
    await loadProfile(paths, profileName);
  } catch {
    console.error(`Profile not found: ${profileName}`);
    process.exit(1);
  }

  await saveInstalledTarget(paths, name, {
    ...installed.spec,
    profile: profileName,
  });
  console.log(`Set target profile: ${name} → ${profileName}`);
}

async function removeTarget(name?: string): Promise<void> {
  if (!name) usage();
  const paths = resolveRuntimePaths();
  await ensureRuntimeState(paths);
  const installed = await loadInstalledTarget(paths, name);
  if (!installed) {
    console.error(`Target not installed: ${name}`);
    process.exit(1);
  }
  await removeInstalledTarget(paths, name);
  console.log(`Removed target definition: ${name}`);
}

async function purgeManagedBlock(spec: TargetSpec): Promise<void> {
  const destination = resolveUserPath(spec.destination);
  if (!existsSync(destination)) return;
  const current = await readFile(destination, "utf8");
  if (!BLOCK_RE.test(current)) return;

  const stripped = stripManagedBlock(current);
  const finalContent = stripped.length > 0 ? `${stripped}\n` : "";
  await writeFile(destination, finalContent, "utf8");
}

async function purgePerFragment(spec: TargetSpec): Promise<void> {
  const destination = resolveUserPath(spec.destination);
  if (!existsSync(destination)) return;
  const files = (await readdir(destination)).filter((file) => file.endsWith(".mdc"));
  for (const file of files) {
    const fullPath = join(destination, file);
    const content = await readFile(fullPath, "utf8");
    if (content.includes(FRAGMENT_MARKER_PREFIX)) {
      await unlink(fullPath);
    }
  }
}

async function purgeTarget(name?: string): Promise<void> {
  if (!name) usage();
  const paths = resolveRuntimePaths();
  await ensureRuntimeState(paths);
  const installed = await loadInstalledTarget(paths, name);
  if (!installed) {
    console.error(`Target not installed: ${name}`);
    process.exit(1);
  }

  if (installed.spec.mode === "per-fragment") {
    await purgePerFragment(installed.spec);
  } else if (installed.spec.mode === "opencode-agent") {
    await purgeOpenCodeProfileAgent(installed.spec.destination, installed.spec.profile);
  } else {
    await purgeManagedBlock(installed.spec);
  }
  console.log(`Purged rendered output for target: ${name}`);
}

export async function runTarget(args: string[]): Promise<void> {
  const [subcommand, name, value] = args;
  switch (subcommand) {
    case "list":
      await listTargets();
      return;
    case "add":
      await addTarget(name);
      return;
    case "set-profile":
      await setTargetProfile(name, value);
      return;
    case "enable":
      await setTargetEnabled(name, true);
      return;
    case "disable":
      await setTargetEnabled(name, false);
      return;
    case "remove":
      await removeTarget(name);
      return;
    case "purge":
      await purgeTarget(name);
      return;
    default:
      usage();
  }
}
