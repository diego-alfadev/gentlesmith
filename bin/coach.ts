#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import {
  buildCleanupPlan,
  runCleanupCoach,
  type CleanupCoachResult,
  type CleanupPlan,
} from "../src/application/coach-cleanup";
import {
  runHarnessAssessment,
  writeAssessmentBundle,
  type AssessmentIntent,
} from "../src/application/harness-assessment";
import { scanAgentSetup } from "../src/application/scan-setup";
import {
  createCliGenerationEngine,
  isEngineId,
  listCliGenerationEngines,
} from "../src/adapters/cli-generation-engine";
import { resolveUserPath } from "./runtime";

export async function runCoach(args = process.argv.slice(3)): Promise<void> {
  const subcommand = args[0]?.startsWith("-") ? undefined : args[0];
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
      ? await runCleanupCoach(scan, createCliGenerationEngine(engineValue), generationOptions(args))
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
  if (subcommand === "assess") {
    await runAssessmentCommand(args);
    return;
  }

  throw new Error(`Unknown coach command: ${subcommand}. Try \`gentlesmith coach cleanup\` or \`gentlesmith coach assess\`.`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function readRepeatedFlag(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : [])
    .filter((value): value is string => Boolean(value && !value.startsWith("-")));
}

async function runAssessmentCommand(args: string[]): Promise<void> {
  const engineId = await resolveAssessmentEngine(readFlag(args, "--engine"));
  const believedCurrentState = readFlag(args, "--current") ?? await input({
    message: "What do you believe your current agent setup contains?",
    validate: requiredAnswer,
  });
  const desiredState = readFlag(args, "--goal") ?? await input({
    message: "What do you want your harness setup to become?",
    validate: requiredAnswer,
  });
  const flagBoundaries = readRepeatedFlag(args, "--boundary");
  const boundaryAnswer = flagBoundaries.length > 0 || !process.stdin.isTTY
    ? undefined
    : await input({
      message: "What must Gentlesmith preserve or avoid?",
      default: "Do not modify existing agent files; keep private capabilities private.",
    });
  const includeProfileSuggestions = args.includes("--profiles")
    ? true
    : args.includes("--no-profiles") || !process.stdin.isTTY
      ? false
      : await confirm({
        message: "Should this assessment suggest additional profiles?",
        default: false,
      });
  const intent: AssessmentIntent = {
    believedCurrentState: believedCurrentState.trim(),
    desiredState: desiredState.trim(),
    boundaries: flagBoundaries.length > 0
      ? flagBoundaries
      : boundaryAnswer?.trim()
        ? [boundaryAnswer.trim()]
        : [],
    includeProfileSuggestions,
  };

  const scan = await scanAgentSetup();
  const engine = createCliGenerationEngine(engineId);
  console.log(`\n⚒ Assessing your harness with ${engine.label}...`);
  const result = await runHarnessAssessment(scan, intent, engine, generationOptions(args));
  const outDir = resolveUserPath(
    readFlag(args, "--out") ?? join(process.cwd(), ".gentlesmith-assessments", assessmentTimestamp()),
  );
  const bundle = await writeAssessmentBundle(resolve(outDir), result);

  console.log(`✓ Assessment proposal completed in ${formatDuration(result.proposal.metrics.durationMs)}.`);
  console.log(`  Bundle: ${bundle.directory}`);
  console.log("  Existing harness files were not changed.");
  console.log("\nReview:");
  console.log(`  ${bundle.files.proposal}`);
  console.log(`  ${bundle.files.context}`);
}

async function resolveAssessmentEngine(value: string | undefined) {
  if (value) {
    if (!isEngineId(value)) {
      throw new Error(`Unknown engine: ${value}. Use one of: codex, claude, gemini, opencode.`);
    }
    return value;
  }

  const available = listCliGenerationEngines().filter((engine) => engine.available);
  if (available.length === 0) throw new Error("No supported generation engine was found on PATH.");
  if (!process.stdin.isTTY) return available[0].id;
  return select({
    message: "Which installed agent should run the assessment?",
    choices: available.map((engine) => ({
      name: `${engine.label} (${engine.id})`,
      value: engine.id,
    })),
  });
}

function generationOptions(args: string[]) {
  const model = readFlag(args, "--model");
  return {
    model,
  };
}

function requiredAnswer(value: string): true | string {
  return value.trim() ? true : "This answer is required to avoid speculative work.";
}

function assessmentTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
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
    `Generation: ${formatDuration(result.proposal.metrics.durationMs)}${result.proposal.metrics.model ? ` · ${result.proposal.metrics.model}` : ""}`,
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
