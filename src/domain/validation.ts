import type { Privacy } from "./artifact";
import type { ResourceGraph } from "./resource-graph";

export type PortabilityIssueKind = "artifact" | "capability";

export interface PortabilityIssue {
  kind: PortabilityIssueKind;
  artifact: string;
  privacy: Exclude<Privacy, "public">;
  path: string;
}

export interface PortabilityReport {
  exportable: boolean;
  issues: PortabilityIssue[];
}

export function checkPublicExportPortability(graph: ResourceGraph): PortabilityReport {
  const issues: PortabilityIssue[] = [];

  for (const node of graph.nodes) {
    const privacy = node.artifact.privacy ?? "public";
    if (privacy === "public") continue;
    issues.push({
      kind: "artifact",
      artifact: node.id,
      privacy,
      path: node.ref,
    });
  }

  for (const capability of graph.capabilities) {
    const privacy = capability.privacy ?? "public";
    if (privacy === "public") continue;
    issues.push({
      kind: "capability",
      artifact: capability.id,
      privacy,
      path: `capabilities.${capability.id}`,
    });
  }

  return {
    exportable: issues.length === 0,
    issues,
  };
}
