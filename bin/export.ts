#!/usr/bin/env bun

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { stringify as stringifyYAML } from "yaml";
import { buildCapabilityMatrix, type CapabilityMatrixCell } from "../src/domain/capability-matrix";
import { loadProfileManifest } from "../src/domain/profile";
import { buildResourceGraph } from "../src/domain/resource-graph";
import { checkPublicExportPortability, type PortabilityReport } from "../src/domain/validation";
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
  publicOnly: boolean;
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

interface ProfileV1ExportCatalog {
  schemaVersion: 1;
  kind: "profile-v1";
  generatedAt: string;
  profile: {
    name: string;
    description?: string;
    targets: string[];
  };
  export: {
    path: string;
    manifest: string;
    artifacts: string;
  };
  artifacts: Array<{
    id: string;
    ref: string;
    type: string;
    exposure: string;
    privacy: string;
    requires: unknown;
  }>;
  capabilities: Array<{
    id: string;
    type: string;
    privacy: string;
    description: string;
    env: unknown[];
    localPaths: unknown[];
    targets: string[];
  }>;
  capabilityMatrix: CapabilityMatrixCell[];
  portability: PortabilityReport;
  warnings: string[];
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
  const profileInput = parsed.profile ?? await resolveDefaultProfile();

  if (isProfileV1Path(profileInput)) {
    await runProfileV1Export({ profilePath: resolveUserPath(profileInput), out: parsed.out, publicOnly: parsed.publicOnly });
    return;
  }

  const profileName = profileInput;
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
    const renderTargets = targets.filter((target) => target.spec.mode !== "opencode-agent");
    if (renderTargets.length > 0) runSyncForProfile(profileName, renderTargets.map((target) => target.name));
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

  if (spec.mode === "opencode-agent") {
    const summaryOut = join(outDir, "rendered", `${name}.md`);
    const sanitized = [
      `# OpenCode target export: ${name}`,
      "",
      "Full OpenCode rendered config is omitted from profile exports because it can contain prompts for unrelated local profiles.",
      "Gentlesmith still records target applicability here; use `gentlesmith sync --target opencode` locally to inspect the full machine-specific render.",
      "",
      `destination: ${destination}`,
      `profile: ${spec.profile}`,
      "",
    ].join("\n");
    await mkdir(dirname(summaryOut), { recursive: true });
    await writeFile(summaryOut, sanitized, "utf8");
    targetSummary.renderedPath = relative(outDir, summaryOut);
    targetSummary.renderedLines = sanitized.split("\n").length;
    summary.push(`- rendered: ${targetSummary.renderedPath} (sanitized; full OpenCode config omitted)`);
    summary.push(`- rendered lines: ${targetSummary.renderedLines}`);
    summary.push("- diff: not applicable for opencode selectable profile", "");
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

async function runProfileV1Export(input: { profilePath: string; out?: string; publicOnly: boolean }): Promise<void> {
  const profile = await loadProfileManifest(input.profilePath);
  const graph = await buildResourceGraph(profile, { baseDir: dirname(input.profilePath) });
  const portability = checkPublicExportPortability(graph);
  const capabilityMatrix = buildCapabilityMatrix(profile);
  const outDir = resolveUserPath(input.out ?? join(PATHS.runtimeHome, "exports", `${profile.name}-v1-${timestamp()}`));
  const generatedAt = new Date().toISOString();

  if (input.publicOnly && !portability.exportable) {
    throw new Error(`Profile v1 export is blocked for public sharing: ${portability.issues.length} portability issue(s). Run without --public to create a local review export.`);
  }

  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, "artifacts"), { recursive: true });
  await copyFile(input.profilePath, join(outDir, "gentlesmith.profile.yaml"));

  for (const node of graph.nodes) {
    if (!node.bodyPath) continue;
    const targetPath = join(outDir, node.ref);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(node.bodyPath, targetPath);
  }

  const catalog: ProfileV1ExportCatalog = {
    schemaVersion: 1,
    kind: "profile-v1",
    generatedAt,
    profile: {
      name: profile.name,
      description: profile.description,
      targets: profile.targets ? Object.keys(profile.targets).sort() : [],
    },
    export: {
      path: outDir,
      manifest: "gentlesmith.profile.yaml",
      artifacts: "artifacts/",
    },
    artifacts: graph.nodes.map((node) => ({
      id: node.id,
      ref: node.ref,
      type: node.artifact.type,
      exposure: node.exposure,
      privacy: node.artifact.privacy ?? "public",
      requires: node.artifact.requires ?? {},
    })),
    capabilities: graph.capabilities.map((capability) => ({
      id: capability.id,
      type: capability.type,
      privacy: capability.privacy ?? "public",
      description: capability.description,
      env: capability.env ?? [],
      localPaths: capability.localPaths ?? [],
      targets: capability.targets ?? [],
    })),
    capabilityMatrix,
    portability,
    warnings: graph.warnings,
  };

  await writeFile(join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "summary.md"), buildProfileV1Summary(catalog), "utf8");
  await updateProfileV1ExportsIndex(catalog);

  console.log(`Profile v1 export written to: ${outDir}`);
  if (!portability.exportable) console.log("Public sharing blocked; review portability issues in summary.md.");
}

function buildProfileV1Summary(catalog: ProfileV1ExportCatalog): string {
  return renderProfileV1Summary(catalog);
}

function renderProfileV1Summary(catalog: ProfileV1ExportCatalog): string {
  const lines = [`# gentlesmith Profile v1 export: ${catalog.profile.name}`, ""];
  lines.push(`- generated: ${catalog.generatedAt}`);
  lines.push(`- output: ${catalog.export.path}`);
  lines.push(`- manifest: ${catalog.export.manifest}`);
  lines.push(`- artifacts: ${catalog.artifacts.length}`);
  lines.push(`- capabilities: ${catalog.capabilities.length}`);
  lines.push(`- portability: ${catalog.portability.exportable ? "public-exportable" : "blocked for public export"}`, "");

  if (catalog.capabilities.length > 0) {
    lines.push("## Capabilities", "");
    for (const capability of catalog.capabilities) {
      lines.push(`- ${capability.id} [${capability.type}] privacy=${capability.privacy}`);
    }
    lines.push("");
  }

  if (catalog.portability.issues.length > 0) {
    lines.push("## Portability issues", "");
    for (const issue of catalog.portability.issues) {
      lines.push(`- ${issue.kind}: ${issue.artifact} (${issue.privacy}) ${issue.path}`);
    }
    lines.push("");
  }

  if (catalog.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of catalog.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function updateProfileV1ExportsIndex(catalog: ProfileV1ExportCatalog): Promise<void> {
  const indexPath = join(PATHS.runtimeHome, "exports", "index.json");
  const current = existsSync(indexPath)
    ? JSON.parse(await readFile(indexPath, "utf8")) as { exports?: unknown[] }
    : { exports: [] };
  const exportsList = Array.isArray(current.exports) ? current.exports : [];
  exportsList.push({
    generatedAt: catalog.generatedAt,
    kind: catalog.kind,
    profile: catalog.profile.name,
    path: catalog.export.path,
    publicExportable: catalog.portability.exportable,
    targets: catalog.profile.targets,
  });
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, exports: exportsList }, null, 2) + "\n", "utf8");
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

function runSyncForProfile(profileName: string, targetNames: string[]): void {
  for (const targetName of targetNames) {
    const result = spawnSync("bun", [join(PATHS.packageRoot, "bin/distribute.ts"), "sync", "--target", targetName], {
      env: { ...process.env, GENTLESMITH_HOME: PATHS.runtimeHome },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`sync failed while exporting profile ${profileName} target ${targetName}`);
    }
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
    publicOnly: args.includes("--public"),
  };
}

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function isProfileV1Path(input: string): boolean {
  return existsSync(resolveUserPath(input)) && input.endsWith(".yaml");
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
