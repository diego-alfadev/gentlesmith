#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureRuntimeState,
  listInstalledTargets,
  loadProfile,
  resolveRuntimePaths,
  resolveUserPath,
  type TargetSpec,
} from "./runtime";

const PATHS = resolveRuntimePaths();

interface ExportArgs {
  profile?: string;
  out?: string;
}

export async function runExport(args: string[]): Promise<void> {
  await ensureRuntimeState(PATHS);
  const parsed = parseArgs(args);
  const profileName = parsed.profile ?? await resolveDefaultProfile();
  const outDir = resolveUserPath(parsed.out ?? join(PATHS.runtimeHome, "exports", `${profileName}-${timestamp()}`));

  const targets = (await listInstalledTargets(PATHS)).filter((target) => target.spec.profile === profileName);
  if (targets.length === 0) {
    console.error(`No installed targets found for profile: ${profileName}`);
    process.exit(1);
  }

  const profile = await loadProfile(PATHS, profileName);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "profile.json"), JSON.stringify(profile, null, 2) + "\n", "utf8");

  runSyncForProfile(profileName);

  const summary: string[] = [`# gentlesmith export: ${profileName}`, ""];
  summary.push(`- generated: ${new Date().toISOString()}`);
  summary.push(`- output: ${outDir}`);
  summary.push("");

  for (const target of targets) {
    await exportTarget(outDir, target.name, target.spec, summary);
  }

  await writeFile(join(outDir, "summary.md"), summary.join("\n") + "\n", "utf8");
  console.log(`Export written to: ${outDir}`);
}

async function exportTarget(outDir: string, name: string, spec: TargetSpec, summary: string[]): Promise<void> {
  const renderedPath = join(PATHS.renderedDir, `${name}.md`);
  if (!existsSync(renderedPath)) return;

  const rendered = await readFile(renderedPath, "utf8");
  const renderedOut = join(outDir, "rendered", `${name}.md`);
  await mkdir(dirname(renderedOut), { recursive: true });
  await writeFile(renderedOut, rendered, "utf8");

  if (spec.mode === "opencode-agent") {
    summary.push(`## ${name}`);
    summary.push("");
    summary.push(`- mode: ${spec.mode}`);
    summary.push(`- destination: ${spec.destination}`);
    summary.push(`- rendered prompt lines: ${rendered.split("\n").length}`);
    summary.push("");
    return;
  }

  const destination = resolveUserPath(spec.destination);
  const diffOut = join(outDir, "diffs", `${name}.diff`);
  await mkdir(dirname(diffOut), { recursive: true });

  if (!existsSync(destination)) {
    await writeFile(diffOut, `Destination does not exist: ${destination}\n`, "utf8");
    summary.push(`## ${name}`, "", `- destination missing: ${destination}`, "");
    return;
  }

  const diff = unifiedDiff(destination, renderedPath);
  await writeFile(diffOut, diff, "utf8");
  summary.push(`## ${name}`);
  summary.push("");
  summary.push(`- mode: ${spec.mode}`);
  summary.push(`- destination: ${destination}`);
  summary.push(`- rendered lines: ${rendered.split("\n").length}`);
  summary.push(`- diff: ${relative(outDir, diffOut)}`);
  summary.push("");
}

function runSyncForProfile(profileName: string): void {
  const result = spawnSync("bun", [join(PATHS.packageRoot, "bin/distribute.ts"), "sync"], {
    env: { ...process.env, GENTLESMITH_HOME: PATHS.runtimeHome },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`sync failed while exporting profile ${profileName}`);
  }
}

function unifiedDiff(currentPath: string, renderedPath: string): string {
  const result = spawnSync("diff", ["-u", currentPath, renderedPath], { encoding: "utf8" });
  return result.stdout || "";
}

async function resolveDefaultProfile(): Promise<string> {
  const targets = await listInstalledTargets(PATHS);
  const first = targets.find((target) => target.spec.enabled !== false);
  if (!first) {
    console.error("No enabled installed targets found. Run `gentlesmith init` first.");
    process.exit(1);
  }
  return first.spec.profile;
}

function parseArgs(args: string[]): ExportArgs {
  return {
    profile: readFlag(args, "--profile"),
    out: readFlag(args, "--out"),
  };
}

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function relative(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
