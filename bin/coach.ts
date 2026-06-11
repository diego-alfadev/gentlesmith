#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import {
  buildCleanupPlan,
  runCleanupCoach,
  type CleanupCoachResult,
  type CleanupPlan,
} from "../src/application/coach-cleanup";
import { scanAgentSetup } from "../src/application/scan-setup";
import {
  createCliGenerationEngine,
  isEngineId,
  listCliGenerationEngines,
} from "../src/adapters/cli-generation-engine";
import { resolveUserPath } from "./runtime";

export async function runCoach(args = process.argv.slice(3)): Promise<void> {
  const [subcommand] = args.filter((arg) => !arg.startsWith("-"));
  if (!subcommand || subcommand === "cleanup") {
    if (args.includes("--engines")) {
      console.log(renderEngineList());
      return;
    }

    const scan = await scanAgentSetup();
    const engineValue = readFlag(args, "--engine");
    if (args.includes("--engine") && !engineValue) {
      throw new Error("Missing value for --engine. Use one of: codex, claude, gemini, opencode.");
    }
    if (engineValue && !isEngineId(engineValue)) {
      throw new Error(`Unknown engine: ${engineValue}. Use one of: codex, claude, gemini, opencode.`);
    }
    const result = engineValue && isEngineId(engineValue)
      ? await runCleanupCoach(scan, createCliGenerationEngine(engineValue))
      : undefined;
    const plan = result?.plan ?? buildCleanupPlan(scan);
    const outPath = readFlag(args, "--out");
    if (outPath) {
      const resolved = resolveUserPath(outPath);
      const content = result
        ? renderCleanupResult(result, { includePrompt: true })
        : renderCleanupPlan(plan, { includePrompt: true });
      await writeFile(resolved, content + "\n", "utf8");
      console.log(`Wrote coach ${result ? "proposal" : "handoff"}: ${resolved}`);
      return;
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(result ?? plan, null, 2));
      return;
    }
    console.log(
      result
        ? renderCleanupResult(result, { includePrompt: args.includes("--prompt") })
        : renderCleanupPlan(plan, { includePrompt: args.includes("--prompt") }),
    );
    return;
  }

  throw new Error(`Unknown coach command: ${subcommand}. Try \`gentlesmith coach cleanup\`.`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

export function renderCleanupResult(
  result: CleanupCoachResult,
  options: { includePrompt?: boolean } = {},
): string {
  return [
    renderCleanupPlan(result.plan, options),
    "",
    `Agent proposal (${result.proposal.engine}):`,
    result.proposal.content,
    "",
    "Gentlesmith did not apply any changes. Review the proposal before running a command.",
  ].join("\n");
}

export function renderEngineList(): string {
  const engines = listCliGenerationEngines();
  return [
    "gentlesmith — generation engines",
    ...engines.map((engine) => `${engine.available ? "✓" : "·"} ${engine.id.padEnd(8)} ${engine.label}`),
    "",
    "Run one safely:",
    "  gentlesmith coach cleanup --engine <engine>",
  ].join("\n");
}

export function renderCleanupPlan(plan: CleanupPlan, options: { includePrompt?: boolean } = {}): string {
  const lines = [
    "gentlesmith — coach cleanup",
    plan.summary,
    "",
    "Findings:",
    ...plan.findings.map((finding) => `  - ${finding}`),
    "",
    "Recommended actions:",
    ...plan.recommendedActions.map((action, index) => `  ${index + 1}. ${action}`),
    "",
    "Suggested commands:",
    ...plan.suggestedCommands.map((command) => `  ${command}`),
    "",
    "Risks to review:",
    ...plan.risks.map((risk) => `  - ${risk}`),
  ];

  if (options.includePrompt) {
    lines.push("", "Agent handoff prompt:", "```text", plan.agentHandoffPrompt, "```");
  } else {
    lines.push("", "Agent handoff:");
    lines.push("  gentlesmith coach cleanup --prompt");
  }

  return lines.join("\n");
}
