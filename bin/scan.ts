#!/usr/bin/env bun

import { scanAgentSetup, type ScanSetupResult } from "../src/application/scan-setup";

export async function runScan(args = process.argv.slice(3)): Promise<void> {
  const extraPaths = collectRepeatedFlag(args, "--path");
  const result = await scanAgentSetup({ extraPaths });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderScanResult(result));
}

export function renderScanResult(result: ScanSetupResult): string {
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

  for (const candidate of result.candidates) {
    const icon = candidate.recommended ? "✓" : candidate.kind === "generated" ? "!" : "·";
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

  if (result.capabilities.length > 0) {
    lines.push("Detected capabilities:");
    for (const capability of result.capabilities.slice(0, 25)) {
      const detail = capability.detail ? ` — ${capability.detail}` : "";
      lines.push(`  - ${capability.target}: ${capability.kind}:${capability.id} (${capability.sourcePath})${detail}`);
    }
    if (result.capabilities.length > 25) lines.push(`  ... ${result.capabilities.length - 25} more capabilities`);
    lines.push("");
  }

  const recommended = result.candidates.find((candidate) => candidate.recommended);
  if (recommended) {
    lines.push("Recommended next step:");
    lines.push("  gentlesmith import jarvis");
    lines.push(`  ${"# uses "}${recommended.path}`);
  } else {
    lines.push("Recommended next step:");
    lines.push("  Open `gentlesmith browse` and choose the safest source manually.");
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
