import type { CapabilityCandidate, ScanSetupResult, SourceCandidate } from "./scan-setup";
import {
  generateAgentProposal,
  type AgentProposal,
  type GenerationEngine,
  type GenerationOptions,
} from "./generation-engine";

export interface ScanBrief {
  sources: {
    total: number;
    personal: number;
    generated: number;
    project: number;
    unknown: number;
  };
  recommendedSource?: {
    path: string;
    importableSections: number;
  };
  alternatePersonalSources: Array<{
    path: string;
    importableSections: number;
  }>;
  generatedOutputs: Array<{
    path: string;
    reviewSections: number;
  }>;
  projectOverlays: Array<{
    path: string;
    importableSections: number;
  }>;
  capabilitiesByTarget: Array<{
    target: string;
    total: number;
    kinds: Record<string, number>;
  }>;
  warnings: string[];
}

export interface CleanupPlan {
  title: string;
  summary: string;
  brief: ScanBrief;
  findings: string[];
  recommendedActions: string[];
  suggestedCommands: string[];
  risks: string[];
  agentHandoffPrompt: string;
}

export interface CleanupCoachResult {
  plan: CleanupPlan;
  proposal: AgentProposal;
}

export function buildScanBrief(scan: ScanSetupResult): ScanBrief {
  const recommended = scan.candidates.find((candidate) => candidate.recommended);
  const personal = scan.candidates.filter((candidate) => candidate.kind === "personal-system");
  const generated = scan.candidates.filter((candidate) => candidate.kind === "generated");
  const project = scan.candidates.filter((candidate) => candidate.kind === "project-overlay");

  return {
    sources: {
      total: scan.candidates.length,
      personal: personal.length,
      generated: generated.length,
      project: project.length,
      unknown: scan.candidates.filter((candidate) => candidate.kind === "unknown").length,
    },
    recommendedSource: recommended ? sourceSummary(recommended) : undefined,
    alternatePersonalSources: personal
      .filter((candidate) => !candidate.recommended)
      .map(sourceSummary),
    generatedOutputs: generated.map((candidate) => ({
      path: candidate.path,
      reviewSections: candidate.sections.review,
    })),
    projectOverlays: project.map(sourceSummary),
    capabilitiesByTarget: groupCapabilities(scan.capabilities),
    warnings: scan.warnings,
  };
}

export function buildCleanupPlan(scan: ScanSetupResult): CleanupPlan {
  const brief = buildScanBrief(scan);
  const findings = buildFindings(brief);
  const recommendedActions = buildRecommendedActions(brief);
  const suggestedCommands = buildSuggestedCommands(brief);
  const risks = buildRisks(brief);

  return {
    title: "Harness cleanup plan",
    summary: brief.recommendedSource
      ? "Gentlesmith found a safe starter source and can draft a neutral profile without treating any agent as the master."
      : "Gentlesmith did not find a safe starter source automatically; choose one manually before importing.",
    brief,
    findings,
    recommendedActions,
    suggestedCommands,
    risks,
    agentHandoffPrompt: buildAgentHandoffPrompt(brief),
  };
}

export async function runCleanupCoach(
  scan: ScanSetupResult,
  engine: GenerationEngine,
  options: GenerationOptions = {},
): Promise<CleanupCoachResult> {
  const plan = buildCleanupPlan(scan);
  const proposal = await generateAgentProposal(plan.agentHandoffPrompt, engine, options);
  return { plan, proposal };
}

function sourceSummary(candidate: SourceCandidate): { path: string; importableSections: number } {
  return {
    path: candidate.path,
    importableSections: candidate.sections.import,
  };
}

function groupCapabilities(capabilities: CapabilityCandidate[]): ScanBrief["capabilitiesByTarget"] {
  const grouped = new Map<string, CapabilityCandidate[]>();
  for (const capability of capabilities) {
    grouped.set(capability.target, [...(grouped.get(capability.target) ?? []), capability]);
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, items]) => ({
      target,
      total: items.length,
      kinds: items.reduce<Record<string, number>>((acc, item) => {
        acc[item.kind] = (acc[item.kind] ?? 0) + 1;
        return acc;
      }, {}),
    }));
}

function buildFindings(brief: ScanBrief): string[] {
  const findings = [
    `${brief.sources.total} instruction source(s) found: ${brief.sources.personal} personal, ${brief.sources.generated} generated, ${brief.sources.project} project overlay(s).`,
    `${capabilityTotal(brief)} ${capabilityTotal(brief) === 1 ? "capability" : "capabilities"} detected across ${brief.capabilitiesByTarget.length} target(s).`,
  ];

  if (brief.recommendedSource) {
    findings.push(`Recommended starter source: ${brief.recommendedSource.path} (${brief.recommendedSource.importableSections} importable section(s)).`);
  }
  if (brief.alternatePersonalSources.length > 0) {
    findings.push(`${brief.alternatePersonalSources.length} alternate personal source(s) should be compared before declaring the profile complete.`);
  }
  if (brief.generatedOutputs.length > 0) {
    findings.push(`${brief.generatedOutputs.length} generated output(s) should be treated as render results, not source of truth.`);
  }
  if (brief.projectOverlays.length > 0) {
    findings.push(`${brief.projectOverlays.length} project overlay(s) detected; keep them separate from the personal/system profile for now.`);
  }

  return findings;
}

function capabilityTotal(brief: ScanBrief): number {
  return brief.capabilitiesByTarget.reduce((total, target) => total + target.total, 0);
}

function buildRecommendedActions(brief: ScanBrief): string[] {
  const actions: string[] = [];

  if (brief.recommendedSource) {
    actions.push("Draft a target-neutral profile from the recommended personal/system source.");
  } else {
    actions.push("Choose a personal/system source manually before importing.");
  }
  if (brief.alternatePersonalSources.length > 0) {
    actions.push("Review alternate personal sources for unique rules before deleting or overwriting anything.");
  }
  if (brief.generatedOutputs.length > 0) {
    actions.push("Ignore generated outputs during import unless you intentionally pass --force.");
  }
  if (brief.capabilitiesByTarget.length > 0) {
    actions.push("Keep capabilities private by default, then promote only portable MCP/tool assumptions into the profile.");
  }
  actions.push("Render/apply to one target first, review the diff, then expand to other targets.");

  return actions;
}

function buildSuggestedCommands(brief: ScanBrief): string[] {
  const commands = ["gentlesmith scan --verbose"];
  if (brief.recommendedSource) {
    commands.push("gentlesmith import jarvis");
    commands.push("gentlesmith v1 inspect --profile .gentlesmith-v1-draft-jarvis/gentlesmith.profile.yaml");
    commands.push("gentlesmith export --profile .gentlesmith-v1-draft-jarvis/gentlesmith.profile.yaml");
  } else {
    commands.push("gentlesmith import jarvis --source <path>");
  }
  commands.push("gentlesmith target set-profile <target> .gentlesmith-v1-draft-jarvis/gentlesmith.profile.yaml");
  commands.push("gentlesmith sync --target <target>");
  return commands;
}

function buildRisks(brief: ScanBrief): string[] {
  const risks: string[] = [];

  if (brief.generatedOutputs.length > 0) {
    risks.push("Generated outputs may contain stale or already-rendered instructions; importing them can duplicate or fossilize behavior.");
  }
  if (brief.alternatePersonalSources.length > 0) {
    risks.push("Alternate personal sources may contain useful rules missing from the recommended starter source.");
  }
  if (brief.capabilitiesByTarget.some((target) => target.kinds.hook || target.kinds.plugin)) {
    risks.push("Hooks/plugins are target-specific and should not be treated as portable profile behavior without review.");
  }
  if (risks.length === 0) risks.push("No obvious cleanup risk detected, but review generated profile artifacts before applying.");

  return risks;
}

function buildAgentHandoffPrompt(brief: ScanBrief): string {
  return [
    "Act as a Gentlesmith profile architect.",
    "Use this scan brief to help clean and unify an AI-agent harness without losing agent-specific capabilities.",
    "Operate in read-only proposal mode. Do not create, edit, move, or delete files, and do not run mutating commands.",
    "Base the proposal on this supplied brief; ask for missing evidence instead of changing the environment.",
    brief.recommendedSource ? `Starter source: ${brief.recommendedSource.path}` : "No starter source was selected automatically.",
    `Alternate personal sources: ${brief.alternatePersonalSources.map((source) => source.path).join(", ") || "none"}.`,
    `Generated outputs to avoid as source of truth: ${brief.generatedOutputs.map((source) => source.path).join(", ") || "none"}.`,
    `Capabilities by target: ${brief.capabilitiesByTarget.map((target) => `${target.target}:${target.total}`).join(", ") || "none"}.`,
    "Return a conservative cleanup proposal with source-of-truth, fragments to create, capabilities to keep private, and first safe commands.",
  ].join("\n");
}
