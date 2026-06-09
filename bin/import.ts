#!/usr/bin/env bun

import { join } from "node:path";
import { modularizeAgentsProfile, type ModularizeAgentsResult } from "../src/application/modularize-agents";
import { scanAgentSetup, type CapabilityCandidate } from "../src/application/scan-setup";
import type { ProfileCapabilityRef } from "../src/domain/profile";
import { resolveUserPath } from "./runtime";

interface ImportArgs {
  name?: string;
  source?: string;
  out?: string;
  target?: string;
  dryRun: boolean;
  json: boolean;
}

export async function runImport(args = process.argv.slice(3)): Promise<void> {
  const parsed = parseImportArgs(args);
  const profileName = normalizeProfileName(parsed.name ?? "jarvis");
  const scan = await scanAgentSetup();
  const sourcePath = parsed.source ? resolveUserPath(parsed.source) : recommendedSourcePath(scan);
  const outDir = resolveUserPath(parsed.out ?? `.gentlesmith-v1-draft-${slugify(profileName)}`);
  const targetName = parsed.target;
  const capabilities = targetName ? profileCapabilitiesForTarget(scan.capabilities, targetName) : [];

  const result = await modularizeAgentsProfile({
    sourcePath,
    outDir,
    profileName: slugify(profileName),
    targetName,
    capabilities,
    dryRun: parsed.dryRun,
  });

  if (parsed.json) {
    console.log(JSON.stringify(importSummary(result), null, 2));
    return;
  }

  console.log(renderImportResult(result));
}

function parseImportArgs(args: string[]): ImportArgs {
  return {
    name: readFlag(args, "--name") ?? readPositionalName(args),
    source: readFlag(args, "--source") ?? readFlag(args, "--from-agents"),
    out: readFlag(args, "--out"),
    target: readFlag(args, "--target"),
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
  };
}

function recommendedSourcePath(scan: Awaited<ReturnType<typeof scanAgentSetup>>): string {
  const recommended = scan.candidates.find((candidate) => candidate.recommended && candidate.kind === "personal-system");
  if (!recommended) {
    throw new Error("No recommended personal/system agent instructions found. Run `gentlesmith scan` or pass `--source <path>`.");
  }
  return recommended.path;
}

function profileCapabilitiesForTarget(capabilities: CapabilityCandidate[], targetName: string): ProfileCapabilityRef[] {
  return capabilities
    .filter((capability) => capability.target === targetName)
    .filter((capability) => capability.kind === "mcp" || capability.kind === "hook")
    .map((capability) => ({
      id: slugify(`${capability.target}-${capability.kind}-${capability.id}`),
      type: capability.kind === "mcp" ? "mcp" : "hook",
      description: `Detected ${capability.kind} capability ${capability.id} for ${capability.target}.`,
      privacy: "private" as const,
      targets: [capability.target],
      overrides: {
        sourcePath: capability.sourcePath,
        detectedId: capability.id,
      },
    }));
}

function renderImportResult(result: ModularizeAgentsResult): string {
  const lines = [
    result.wroteFiles ? "gentlesmith import draft written" : "gentlesmith import preview",
    `Profile: ${result.profileName}`,
    `Draft:   ${result.outDir}`,
    `Source:  ${result.sourcePath}`,
    "",
    "Artifacts:",
  ];

  for (const artifact of result.artifacts) {
    lines.push(`  + ${artifact.type.padEnd(14)} ${artifact.name} -> ${artifact.ref}`);
  }

  if (result.capabilities.length > 0) {
    lines.push("", "Capabilities:");
    for (const capability of result.capabilities) lines.push(`  + ${capability.type.padEnd(7)} ${capability.id}`);
  }

  if (result.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const skipped of result.skipped) lines.push(`  - ${skipped.title}: ${skipped.reason}`);
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of result.warnings) lines.push(`  ! ${warning}`);
  }

  lines.push(
    "",
    "Next:",
    `  gentlesmith v1 inspect --profile ${result.manifestPath}`,
    `  gentlesmith export --profile ${result.manifestPath}`,
    ...(result.targetName ? [
      `  gentlesmith target set-profile ${result.targetName} ${result.manifestPath}`,
      `  gentlesmith sync --target ${result.targetName}`,
    ] : [
      "  choose a target when you are ready to apply:",
      `  gentlesmith target set-profile <target> ${result.manifestPath}`,
      "  gentlesmith sync --target <target>",
    ]),
  );

  return lines.join("\n");
}

function importSummary(result: ModularizeAgentsResult) {
  return {
    profile: result.profileName,
    source: result.sourcePath,
    outDir: result.outDir,
    manifest: result.manifestPath,
    target: result.targetName ?? null,
    wroteFiles: result.wroteFiles,
    artifacts: result.artifacts,
    capabilities: result.capabilities,
    skipped: result.skipped,
    warnings: result.warnings,
    nextCommands: result.nextCommands,
  };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function readPositionalName(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function normalizeProfileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Profile name must not be empty.");
  return trimmed;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "jarvis";
}
