import type { RenderedTargetOutput } from "./target-adapter";
import type { ResourceGraph, ResourceGraphNode } from "../domain/resource-graph";

export function renderManagedMarkdown(input: {
  graph: ResourceGraph;
  targetName: string;
}): RenderedTargetOutput {
  const lines: string[] = [`# Gentlesmith Profile: ${input.graph.profile.name}`, ""];

  if (input.graph.profile.description) {
    lines.push(input.graph.profile.description, "");
  }

  for (const node of input.graph.nodes) {
    if (node.exposure === "none") continue;
    if (node.exposure === "mention") {
      lines.push(...renderMention(node), "");
      continue;
    }
    lines.push(...renderEmbed(node), "");
  }

  return {
    content: `${trimTrailingBlankLines(lines).join("\n")}\n`,
    warnings: input.graph.warnings,
  };
}

function renderEmbed(node: ResourceGraphNode): string[] {
  const lines = [`## ${labelFor(node)}: ${titleFor(node)}`, "", node.artifact.description, ""];
  const requires = renderRequires(node);
  if (requires.length > 0) lines.push(...requires, "");
  lines.push(node.body);
  return lines;
}

function renderMention(node: ResourceGraphNode): string[] {
  const label = labelFor(node);
  if (node.artifact.type === "skill-ref") {
    return [
      `## ${label}: ${node.artifact.name}`,
      "",
      `Use/load external skill \`${node.artifact.name}\`: ${node.artifact.description}`,
    ];
  }
  return [`## ${label}: ${titleFor(node)}`, "", `Reference \`${node.artifact.name}\`: ${node.artifact.description}`];
}

function renderRequires(node: ResourceGraphNode): string[] {
  const requires = node.artifact.requires;
  if (!requires) return [];
  const lines: string[] = [];
  if (requires.skills?.length) lines.push(`Requires skills: ${requires.skills.join(", ")}`);
  if (requires.capabilities?.length) lines.push(`Requires capabilities: ${requires.capabilities.join(", ")}`);
  if (requires.artifacts?.length) lines.push(`Requires artifacts: ${requires.artifacts.join(", ")}`);
  return lines;
}

function labelFor(node: ResourceGraphNode): string {
  const labels: Record<ResourceGraphNode["artifact"]["type"], string> = {
    "capability-ref": "Capability Reference",
    context: "Context",
    prompt: "Prompt",
    rule: "Rule",
    "skill-ref": "Skill Reference",
    workflow: "Workflow",
  };
  return labels[node.artifact.type];
}

function titleFor(node: ResourceGraphNode): string {
  const override = adapterOverrideFor(node);
  if (typeof override.title === "string" && override.title.trim().length > 0) {
    return override.title;
  }
  const heading = /^#{1,3}\s+(.+)$/m.exec(node.body);
  return heading?.[1]?.trim() || node.artifact.name;
}

function adapterOverrideFor(node: ResourceGraphNode): Record<string, unknown> {
  const raw = node.overrides?.["markdown-managed-block"];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out[out.length - 1] === "") out.pop();
  return out;
}
