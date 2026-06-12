import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentProposal, GenerationEngine, GenerationOptions } from "./generation-engine";
import { generateAgentProposal } from "./generation-engine";
import type { ScanSetupResult } from "./scan-setup";

export interface AssessmentIntent {
  believedCurrentState: string;
  desiredState: string;
  boundaries: string[];
  includeProfileSuggestions: boolean;
}

export interface HarnessAssessmentResult {
  intent: AssessmentIntent;
  scan: ScanSetupResult;
  prompt: string;
  proposal: AgentProposal;
}

export interface AssessmentBundle {
  directory: string;
  files: {
    context: string;
    prompt: string;
    proposal: string;
    run: string;
  };
}

export async function runHarnessAssessment(
  scan: ScanSetupResult,
  intent: AssessmentIntent,
  engine: GenerationEngine,
  options: GenerationOptions = {},
): Promise<HarnessAssessmentResult> {
  validateAssessmentIntent(intent);
  const prompt = buildHarnessAssessmentPrompt(scan, intent);
  const proposal = await generateAgentProposal(prompt, engine, options);
  return { intent, scan, prompt, proposal };
}

export function buildHarnessAssessmentPrompt(
  scan: ScanSetupResult,
  intent: AssessmentIntent,
): string {
  validateAssessmentIntent(intent);
  const evidence = {
    cwd: scan.cwd,
    sources: scan.candidates.map((candidate) => ({
      path: candidate.path,
      kind: candidate.kind,
      confidence: candidate.confidence,
      recommended: candidate.recommended,
      reason: candidate.reason,
      notes: candidate.notes,
      sections: candidate.sections,
    })),
    capabilities: scan.capabilities,
    warnings: scan.warnings,
  };

  return [
    "Act as a Gentlesmith harness assessment architect.",
    "Your task is to compare the user's stated understanding and desired outcome against the supplied scan evidence.",
    "",
    "Safety and scope:",
    "- Operate in read-only proposal mode. Do not create, edit, move, or delete files.",
    "- Do not run mutating commands.",
    "- You may inspect only the sourcePath/path files explicitly present in the evidence below.",
    "- Treat generated outputs as rendered evidence, never as canonical source of truth.",
    "- Never expose secret values. Refer to secret names or environment-variable references only.",
    "- If evidence is missing, record the gap instead of inventing configuration.",
    "",
    "User intent:",
    `- What the user believes exists today: ${intent.believedCurrentState}`,
    `- What the user wants to achieve: ${intent.desiredState}`,
    `- Boundaries: ${intent.boundaries.join("; ") || "none stated"}`,
    `- Profile suggestions requested: ${intent.includeProfileSuggestions ? "yes" : "no"}`,
    "",
    "Waste-avoidance rules:",
    "- Recommend only work that directly advances the stated desired outcome.",
    "- Do not propose profiles, scenarios, fragments, or migrations merely because they are possible.",
    intent.includeProfileSuggestions
      ? "- Profile suggestions are allowed, but each must be tied to an explicit user outcome."
      : "- Do not propose additional profiles. Focus only on aligning and improving the requested setup.",
    "",
    "Required response structure:",
    "## Executive assessment",
    "## Confirmed current state",
    "## Differences from the user's understanding",
    "## Conflicts and duplication",
    "## Desired-state gaps",
    "## Proposed source of truth",
    "## Proposed modular changes",
    "## Capabilities and target-specific exceptions",
    "## Safe migration sequence",
    "## Missing evidence and questions",
    ...(intent.includeProfileSuggestions ? ["## Optional profile suggestions"] : []),
    "",
    "For every proposed change, state: evidence, reason, expected value, portability, and risk.",
    "Do not apply anything. This assessment will be compared with a separate human assessment.",
    "",
    "Scan evidence (JSON):",
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

export async function writeAssessmentBundle(
  outDir: string,
  result: HarnessAssessmentResult,
): Promise<AssessmentBundle> {
  await mkdir(dirname(outDir), { recursive: true });
  await mkdir(outDir);

  const files = {
    context: join(outDir, "assessment-context.json"),
    prompt: join(outDir, "agent-prompt.md"),
    proposal: join(outDir, "agent-proposal.md"),
    run: join(outDir, "run-metadata.json"),
  };

  await writeFile(files.context, JSON.stringify({
    intent: result.intent,
    scan: result.scan,
  }, null, 2) + "\n", "utf8");
  await writeFile(files.prompt, result.prompt + "\n", "utf8");
  await writeFile(files.proposal, result.proposal.content + "\n", "utf8");
  await writeFile(files.run, JSON.stringify({
    engine: result.proposal.engine,
    metrics: result.proposal.metrics,
    generatedAt: new Date().toISOString(),
    appliedChanges: false,
  }, null, 2) + "\n", "utf8");

  return { directory: outDir, files };
}

function validateAssessmentIntent(intent: AssessmentIntent): void {
  if (!intent.believedCurrentState.trim()) {
    throw new Error("Assessment requires the user's understanding of the current setup.");
  }
  if (!intent.desiredState.trim()) {
    throw new Error("Assessment requires the user's desired outcome.");
  }
}
