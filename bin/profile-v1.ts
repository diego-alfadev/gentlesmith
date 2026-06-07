#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderManagedMarkdown } from "../src/adapters/markdown-managed-block";
import { loadProfileManifest } from "../src/domain/profile";
import { buildResourceGraph } from "../src/domain/resource-graph";
import { checkPublicExportPortability } from "../src/domain/validation";
import { catalogAgentsMarkdown } from "../src/importers/agents-cataloger";
import { modularizeAgentsProfile, type ModularizeAgentsResult } from "../src/application/modularize-agents";

export async function runProfileV1Command(args: string[]): Promise<string> {
  const [command, ...rest] = args;
  if (command === "render") return runRender(rest);
  if (command === "catalog-agents") return runCatalogAgents(rest);
  if (command === "inspect") return runInspect(rest);
  if (command === "assimilate") return runAssimilate(rest);
  throw new Error(`Unknown profile v1 command: ${command ?? "(missing)"}`);
}

async function runRender(args: string[]): Promise<string> {
  const profilePath = readRequiredFlag(args, "--profile");
  const targetName = readRequiredFlag(args, "--target");
  const profile = await loadProfileManifest(profilePath);
  const graph = await buildResourceGraph(profile, { baseDir: dirname(profilePath) });
  const target = profile.targets?.[targetName];

  if (!target) throw new Error(`Target not declared in profile: ${targetName}`);
  if (target.adapter !== "markdown-managed-block") {
    throw new Error(`Unsupported v1 adapter: ${target.adapter}`);
  }

  return renderManagedMarkdown({ graph, targetName }).content;
}

async function runCatalogAgents(args: string[]): Promise<string> {
  const sourcePath = readRequiredFlag(args, "--source");
  const source = await readFile(sourcePath, "utf8");
  const catalog = catalogAgentsMarkdown(source);

  if (args.includes("--json")) return `${JSON.stringify(catalog, null, 2)}\n`;

  const lines = ["# AGENTS.md Catalog", ""];
  for (const artifact of catalog.artifacts) {
    lines.push(`- ${artifact.frontmatter.type}: ${artifact.frontmatter.name} — ${artifact.frontmatter.description}`);
  }
  if (catalog.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const warning of catalog.warnings) lines.push(`- ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runAssimilate(args: string[]): Promise<string> {
  const sourcePath = readRequiredFlag(args, "--source");
  const outDir = readRequiredFlag(args, "--out");
  const profileName = readFlag(args, "--name");
  const targetName = readFlag(args, "--target");
  const result = await modularizeAgentsProfile({
    sourcePath,
    outDir,
    profileName,
    targetName,
    dryRun: args.includes("--dry-run"),
  });

  return args.includes("--json") ? `${JSON.stringify(assimilateSummary(result), null, 2)}\n` : renderAssimilateSummary(result);
}

function assimilateSummary(result: ModularizeAgentsResult) {
  return {
    profile: result.profileName,
    manifest: result.manifestPath,
    artifacts: result.artifacts,
    warnings: result.warnings,
  };
}

function renderAssimilateSummary(result: ModularizeAgentsResult): string {
  const lines = [
    result.wroteFiles ? "Profile assimilated." : "Profile assimilation preview.",
    `Profile: ${result.profileName}`,
    `Manifest: ${result.manifestPath}`,
    "",
    "Artifacts:",
  ];

  for (const artifact of result.artifacts) {
    lines.push(`- ${artifact.type}: ${artifact.name} -> ${artifact.ref}`);
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  return `${lines.join("\n")}\n`;
}

async function runInspect(args: string[]): Promise<string> {
  const profilePath = readRequiredFlag(args, "--profile");
  const profile = await loadProfileManifest(profilePath);
  const graph = await buildResourceGraph(profile, { baseDir: dirname(profilePath) });
  const portability = checkPublicExportPortability(graph);
  const summary = {
    profile: {
      name: graph.profile.name,
      description: graph.profile.description,
      targets: graph.profile.targets ? Object.keys(graph.profile.targets).sort() : [],
    },
    capabilities: graph.capabilities.map((capability) => ({
      id: capability.id,
      type: capability.type,
      privacy: capability.privacy ?? "public",
      description: capability.description,
      env: capability.env ?? [],
      targets: capability.targets ?? [],
      overrides: capability.overrides ?? {},
    })),
    environment: graph.capabilities.flatMap((capability) => (capability.env ?? []).map((env) => ({
      capability: capability.id,
      name: env.name,
      required: env.required ?? true,
      secret: env.secret ?? false,
      description: env.description,
    }))),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      ref: node.ref,
      type: node.artifact.type,
      exposure: node.exposure,
      privacy: node.artifact.privacy ?? "public",
      description: node.artifact.description,
      requires: node.artifact.requires ?? {},
      overrides: node.overrides ?? {},
    })),
    edges: graph.edges,
    portability,
    warnings: graph.warnings,
  };

  if (args.includes("--json")) return `${JSON.stringify(summary, null, 2)}\n`;

  const lines = [
    `Profile: ${summary.profile.name}`,
    summary.profile.description ? `Description: ${summary.profile.description}` : undefined,
    `Targets: ${summary.profile.targets.length > 0 ? summary.profile.targets.join(", ") : "(none)"}`,
    `Portability: ${portability.exportable ? "public-exportable" : "blocked for public export"}`,
    "",
    "Artifacts:",
  ].filter((line): line is string => line !== undefined);

  for (const node of summary.nodes) {
    lines.push(`- ${node.id} [${node.type}] exposure=${node.exposure} privacy=${node.privacy}`);
  }

  if (summary.capabilities.length > 0) {
    lines.push("", "Capabilities:");
    for (const capability of summary.capabilities) {
      lines.push(`- ${capability.id} [${capability.type}] privacy=${capability.privacy}`);
      for (const env of capability.env) {
        const flags = [env.required ? "required" : "optional", env.secret ? "secret-ref" : "env-ref"].join(", ");
        lines.push(`  env ${env.name} (${flags})`);
      }
    }
  }

  if (portability.issues.length > 0) {
    lines.push("", "Portability issues:");
    for (const issue of portability.issues) {
      lines.push(`- ${issue.kind}: ${issue.artifact} (${issue.privacy}) ${issue.path}`);
    }
  }

  if (summary.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of summary.warnings) lines.push(`- ${warning}`);
  }

  return `${lines.join("\n")}\n`;
}

function readRequiredFlag(args: string[], flag: string): string {
  const value = readFlag(args, flag);
  if (!value) throw new Error(`Missing required flag: ${flag}`);
  return value;
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}
