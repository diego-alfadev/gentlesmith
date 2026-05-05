#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { stringify as stringifyYAML } from "yaml";
import {
  ensureRuntimeState,
  listInstalledTargets,
  loadProfile,
  resolveFragmentPath,
  resolveRuntimePaths,
  resolveUserPath,
  type ProfileSpec,
  type TargetSpec,
} from "./runtime";

const PATHS = resolveRuntimePaths();

interface ExportArgs {
  profile?: string;
  out?: string;
}

interface FragmentExportSummary {
  ref: string;
  source: "local" | "repo" | "missing";
  sourcePath: string;
  exportPath?: string;
}

interface TargetExportSummary {
  name: string;
  agent: string;
  mode: TargetSpec["mode"];
  destination: string;
  enabled: boolean;
  renderedPath?: string;
  diffPath?: string;
  renderedLines?: number;
  destinationExists?: boolean;
}

interface CatalogExportSpec {
  schemaVersion: 1;
  generatedAt: string;
  profile: {
    name: string;
    description?: string;
    include: string[];
    skills: string[];
  };
  export: {
    path: string;
    profileSpec: string;
    sourceFragments: string;
    renderedOutputs: string;
    diffs: string;
  };
  envAssumptions: {
    refs: string[];
    mode: "env-aware" | "env-agnostic";
  };
  targetApplicability: TargetExportSummary[];
  sourceFragments: FragmentExportSummary[];
  changelog: string[];
}

export async function runExport(args: string[]): Promise<void> {
  await ensureRuntimeState(PATHS);
  const parsed = parseArgs(args);
  const profileName = parsed.profile ?? await resolveDefaultProfile();
  const outDir = resolveUserPath(parsed.out ?? join(PATHS.runtimeHome, "exports", `${profileName}-${timestamp()}`));

  const profile = await loadProfile(PATHS, profileName);
  const installedTargets = await listInstalledTargets(PATHS);
  const targets = installedTargets.filter((target) => target.spec.profile === profileName);
  const generatedAt = new Date().toISOString();

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "profile.json"), JSON.stringify(profile, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "profile.yaml"), stringifyYAML(profile), "utf8");

  const fragments = await exportSourceFragments(outDir, profile);
  const targetSummaries: TargetExportSummary[] = [];
  const summary: string[] = [`# gentlesmith export: ${profileName}`, ""];
  summary.push(`- generated: ${generatedAt}`);
  summary.push(`- output: ${outDir}`);
  summary.push(`- profile: ${profileName}`);
  summary.push(`- fragments: ${profile.include.length}`);
  summary.push(`- target bindings: ${targets.length}`);
  summary.push("");

  if (targets.length > 0) {
    runSyncForProfile(profileName);
    for (const target of targets) {
      targetSummaries.push(await exportTarget(outDir, target.name, target.spec, summary));
    }
  } else {
    summary.push("## Target applicability", "");
    summary.push("No installed targets currently bind to this profile.");
    summary.push("This export is still valid as a profile spec for review, sharing, sub-agents, framework agents, or future target binding.", "");
  }

  const catalog = buildCatalog({ outDir, generatedAt, profile, fragments, targets: targetSummaries });
  appendProfileSummary(summary, catalog);

  await writeFile(join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "CHANGELOG.md"), buildChangelog(profileName, generatedAt), "utf8");
  await writeFile(join(outDir, "summary.md"), summary.join("\n") + "\n", "utf8");
  await updateExportsIndex(catalog);

  console.log(`Export written to: ${outDir}`);
  if (targets.length === 0) console.log("No installed targets bind this profile yet; wrote profile spec and source fragments only.");
}

async function exportSourceFragments(outDir: string, profile: ProfileSpec): Promise<FragmentExportSummary[]> {
  const fragments: FragmentExportSummary[] = [];

  for (const ref of profile.include) {
    if (ref.includes("..")) throw new Error(`Fragment ref must not contain "..": ${ref}`);

    const sourcePath = resolveFragmentPath(PATHS, ref);
    const source = !existsSync(sourcePath)
      ? "missing"
      : sourcePath.startsWith(PATHS.localFragmentsDir)
        ? "local"
        : "repo";
    const exportPath = join("source-fragments", `${slugify(ref)}.md`);

    if (source !== "missing") {
      await mkdir(dirname(join(outDir, exportPath)), { recursive: true });
      await writeFile(join(outDir, exportPath), await readFile(sourcePath, "utf8"), "utf8");
    }

    fragments.push({ ref, source, sourcePath, exportPath: source === "missing" ? undefined : exportPath });
  }

  return fragments;
}

async function exportTarget(outDir: string, name: string, spec: TargetSpec, summary: string[]): Promise<TargetExportSummary> {
  const renderedPath = join(PATHS.renderedDir, `${name}.md`);
  const destination = resolveUserPath(spec.destination);
  const targetSummary: TargetExportSummary = {
    name,
    agent: spec.agent,
    mode: spec.mode,
    destination,
    enabled: spec.enabled !== false,
    destinationExists: existsSync(destination),
  };

  summary.push(`## ${name}`, "");
  summary.push(`- agent: ${spec.agent}`);
  summary.push(`- mode: ${spec.mode}`);
  summary.push(`- destination: ${destination}`);
  summary.push(`- enabled: ${targetSummary.enabled ? "yes" : "no"}`);

  if (!targetSummary.enabled) {
    summary.push("- rendered: skipped because target is disabled", "");
    return targetSummary;
  }

  if (!existsSync(renderedPath)) {
    summary.push("- rendered: not available", "");
    return targetSummary;
  }

  const rendered = await readFile(renderedPath, "utf8");
  const renderedOut = join(outDir, "rendered", `${name}.md`);
  await mkdir(dirname(renderedOut), { recursive: true });
  await writeFile(renderedOut, rendered, "utf8");

  targetSummary.renderedPath = relative(outDir, renderedOut);
  targetSummary.renderedLines = rendered.split("\n").length;
  summary.push(`- rendered: ${targetSummary.renderedPath}`);
  summary.push(`- rendered lines: ${targetSummary.renderedLines}`);

  if (spec.mode === "opencode-agent") {
    summary.push("- diff: not applicable for opencode selectable profile", "");
    return targetSummary;
  }

  const diffOut = join(outDir, "diffs", `${name}.diff`);
  await mkdir(dirname(diffOut), { recursive: true });

  if (!targetSummary.destinationExists) {
    await writeFile(diffOut, `Destination does not exist: ${destination}\n`, "utf8");
  } else {
    await writeFile(diffOut, unifiedDiff(destination, renderedPath), "utf8");
  }

  targetSummary.diffPath = relative(outDir, diffOut);
  summary.push(`- diff: ${targetSummary.diffPath}`, "");
  return targetSummary;
}

function buildCatalog(input: {
  outDir: string;
  generatedAt: string;
  profile: ProfileSpec;
  fragments: FragmentExportSummary[];
  targets: TargetExportSummary[];
}): CatalogExportSpec {
  const envRefs = input.profile.include.filter((ref) => ref.startsWith("env/"));
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    profile: {
      name: input.profile.name,
      description: input.profile.description,
      include: input.profile.include,
      skills: input.profile.skills ?? [],
    },
    export: {
      path: input.outDir,
      profileSpec: "profile.yaml",
      sourceFragments: "source-fragments/",
      renderedOutputs: "rendered/",
      diffs: "diffs/",
    },
    envAssumptions: {
      refs: envRefs,
      mode: envRefs.length > 0 ? "env-aware" : "env-agnostic",
    },
    targetApplicability: input.targets,
    sourceFragments: input.fragments,
    changelog: ["Initial local export generated by gentlesmith."],
  };
}

function appendProfileSummary(summary: string[], catalog: CatalogExportSpec): void {
  summary.push("## Profile spec", "");
  summary.push(`- catalog: catalog.json`);
  summary.push(`- profile spec: ${catalog.export.profileSpec}`);
  summary.push(`- source fragments: ${catalog.export.sourceFragments}`);
  summary.push(`- env mode: ${catalog.envAssumptions.mode}`);
  if (catalog.envAssumptions.refs.length > 0) {
    summary.push("- env refs:");
    for (const ref of catalog.envAssumptions.refs) summary.push(`  - ${ref}`);
  }
  summary.push("");
}

function buildChangelog(profileName: string, generatedAt: string): string {
  return [
    `# Export changelog: ${profileName}`,
    "",
    `## ${generatedAt}`,
    "",
    "- Initial local export generated by gentlesmith.",
    "",
  ].join("\n");
}

async function updateExportsIndex(catalog: CatalogExportSpec): Promise<void> {
  const indexPath = join(PATHS.runtimeHome, "exports", "index.json");
  const current = existsSync(indexPath)
    ? JSON.parse(await readFile(indexPath, "utf8")) as { exports?: unknown[] }
    : { exports: [] };
  const exportsList = Array.isArray(current.exports) ? current.exports : [];
  exportsList.push({
    generatedAt: catalog.generatedAt,
    profile: catalog.profile.name,
    path: catalog.export.path,
    envMode: catalog.envAssumptions.mode,
    targets: catalog.targetApplicability.map((target) => target.name),
  });
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, exports: exportsList }, null, 2) + "\n", "utf8");
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
    console.error("No enabled installed targets found. Run `gentlesmith init` first or pass `--profile <profile>`.");
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

function slugify(ref: string): string {
  return ref.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "fragment";
}

function relative(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
