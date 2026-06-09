#!/usr/bin/env bun

import { scanAgentSetup, type ScanSetupResult } from "../src/application/scan-setup";

export async function runScan(args = process.argv.slice(3)): Promise<void> {
  const extraPaths = collectRepeatedFlag(args, "--path");
  const result = await scanAgentSetup({ extraPaths });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderScanResult(result, { verbose: args.includes("--verbose") || args.includes("--details") }));
}

export function renderScanResult(result: ScanSetupResult, options: { verbose?: boolean } = {}): string {
  if (!options.verbose) return renderScanSummary(result);
  return renderScanDetails(result);
}

function renderScanSummary(result: ScanSetupResult): string {
  const recommended = result.candidates.find((candidate) => candidate.recommended);
  const personalSources = result.candidates.filter((candidate) => candidate.kind === "personal-system");
  const generatedSources = result.candidates.filter((candidate) => candidate.kind === "generated");
  const projectSources = result.candidates.filter((candidate) => candidate.kind === "project-overlay");

  const lines = [
    "gentlesmith — scan",
    `Sources: ${result.candidates.length} found (${personalSources.length} personal, ${generatedSources.length} generated, ${projectSources.length} project)`,
    `Capabilities: ${result.capabilities.length} detected${capabilityTargetSummary(result)}`,
    "",
  ];

  if (recommended) {
    lines.push("Recommended source:");
    lines.push(`  ✓ ${recommended.path}`);
    lines.push(`  importable sections: ${recommended.sections.import}`);
    lines.push("");
  } else {
    lines.push("Recommended source:");
    lines.push("  none selected automatically");
    lines.push("");
  }

  if (personalSources.length > 1 && recommended) {
    lines.push("Guidance:");
    lines.push("  No agent is the master. This is only the safest starter source.");
    lines.push("  Use `gentlesmith scan --verbose` to compare all files.");
    lines.push("");
  } else if (generatedSources.length > 0) {
    lines.push("Guidance:");
    lines.push("  Generated outputs were detected and will not be imported by default.");
    lines.push("  Use `gentlesmith scan --verbose` to inspect them.");
    lines.push("");
  }

  lines.push("Next:");
  lines.push(`  ${result.nextAction.command}`);
  if (result.nextAction.kind === "import-recommended") lines.push(`  # uses ${result.nextAction.sourcePath}`);
  else lines.push(`  # ${result.nextAction.note}`);
  lines.push("");
  lines.push("Details:");
  lines.push("  gentlesmith scan --verbose");
  lines.push("  gentlesmith scan --json");

  if (result.warnings.length > 0) {
    lines.push("", `Warnings: ${result.warnings.length}`);
    for (const warning of result.warnings.slice(0, 3)) lines.push(`  - ${warning}`);
    if (result.warnings.length > 3) lines.push(`  ... ${result.warnings.length - 3} more warnings`);
  }

  return lines.join("\n");
}

function renderScanDetails(result: ScanSetupResult): string {
  const lines = [
    "gentlesmith — scan",
    `cwd:  ${result.cwd}`,
    `home: ${result.homeDir}`,
    "",
    "Agent instruction files:",
  ];

  if (result.candidates.length === 0) {
    lines.push("  none found", "", "Next: create a profile with `gentlesmith browse`.");
    return lines.join("\n");
  }

  const recommended = result.candidates.find((candidate) => candidate.recommended);
  for (const candidate of result.candidates) {
    const icon = candidate.path === recommended?.path ? "✓" : candidate.kind === "generated" ? "!" : "·";
    lines.push(`${icon} ${candidate.path}`);
    lines.push(`  kind: ${candidate.kind}`);
    lines.push(`  confidence: ${candidate.confidence}`);
    lines.push(`  reason: ${candidate.reason}`);
    lines.push(`  sections: import ${candidate.sections.import}, exclude ${candidate.sections.exclude}, review ${candidate.sections.review}`);
    for (const note of candidate.notes) lines.push(`  note: ${note}`);
    const excluded = candidate.sections.items.filter((item) => item.disposition !== "import");
    for (const item of excluded.slice(0, 5)) {
      lines.push(`  ${item.disposition}: ${item.title} — ${item.reason}`);
    }
    if (excluded.length > 5) lines.push(`  ... ${excluded.length - 5} more excluded/review sections`);
    lines.push("");
  }

  const personalSources = result.candidates.filter((candidate) => candidate.kind === "personal-system");
  lines.push("Profile source guidance:");
  if (personalSources.length > 1 && recommended) {
    lines.push("  No agent is the master. Gentlesmith found multiple personal/system sources.");
    lines.push(`  Default import uses the highest-ranked starter source: ${recommended.path}`);
    lines.push("  To start from another source, run:");
    lines.push("  gentlesmith import jarvis --source <path>");
  } else if (recommended) {
    lines.push("  One personal/system source is the safest starter source.");
    lines.push("  Import stays target-neutral unless you pass --target <name>.");
  } else {
    lines.push("  No safe personal/system source was selected automatically.");
  }
  lines.push("");

  if (result.capabilities.length > 0) {
    lines.push("Detected capabilities:");
    let renderedCount = 0;
    for (const [target, capabilities] of capabilitiesByTarget(result.capabilities)) {
      lines.push(`  ${target}:`);
      for (const capability of capabilities.slice(0, 10)) {
        const detail = capability.detail ? ` — ${capability.detail}` : "";
        lines.push(`    - ${capability.kind}:${capability.id} (${capability.sourcePath})${detail}`);
        renderedCount += 1;
      }
      if (capabilities.length > 10) {
        lines.push(`    ... ${capabilities.length - 10} more ${target} capabilities`);
      }
    }
    if (result.capabilities.length > renderedCount) lines.push(`  total: ${result.capabilities.length} capabilities`);
    lines.push("");
  }

  if (recommended) {
    lines.push("Recommended next step:");
    lines.push(`  ${result.nextAction.command}`);
    if (result.nextAction.kind === "import-recommended") lines.push(`  ${"# uses "}${result.nextAction.sourcePath}`);
  } else {
    lines.push("Recommended next step:");
    lines.push(`  ${result.nextAction.command}`);
    lines.push(`  ${"# "}${result.nextAction.note}`);
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

function collectRepeatedFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function capabilitiesByTarget(capabilities: ScanSetupResult["capabilities"]): Array<[string, ScanSetupResult["capabilities"]]> {
  const grouped = new Map<string, ScanSetupResult["capabilities"]>();
  for (const capability of capabilities) {
    grouped.set(capability.target, [...(grouped.get(capability.target) ?? []), capability]);
  }
  return Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function capabilityTargetSummary(result: ScanSetupResult): string {
  const grouped = capabilitiesByTarget(result.capabilities);
  if (grouped.length === 0) return "";
  return ` across ${grouped.map(([target, capabilities]) => `${target}:${capabilities.length}`).join(", ")}`;
}
