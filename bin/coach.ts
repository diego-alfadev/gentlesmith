#!/usr/bin/env bun

import { buildCleanupPlan, type CleanupPlan } from "../src/application/coach-cleanup";
import { scanAgentSetup } from "../src/application/scan-setup";

export async function runCoach(args = process.argv.slice(3)): Promise<void> {
  const [subcommand] = args.filter((arg) => !arg.startsWith("-"));
  if (!subcommand || subcommand === "cleanup") {
    const scan = await scanAgentSetup();
    const plan = buildCleanupPlan(scan);
    if (args.includes("--json")) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(renderCleanupPlan(plan, { includePrompt: args.includes("--prompt") }));
    return;
  }

  throw new Error(`Unknown coach command: ${subcommand}. Try \`gentlesmith coach cleanup\`.`);
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
