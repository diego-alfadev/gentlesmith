import type { Privacy } from "./artifact";
import type { ResourceGraph } from "./resource-graph";

export interface PortabilityIssue {
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
      artifact: node.id,
      privacy,
      path: node.ref,
    });
  }

  return {
    exportable: issues.length === 0,
    issues,
  };
}
