import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, posix, win32 } from "node:path";
import { parseArtifactMarkdown, type ArtifactDocument, type Exposure } from "./artifact";
import type { ProfileCapabilityRef, ProfileManifestV1 } from "./profile";

export type ResourceEdgeReason = "requires" | "reference" | "discovered";
export type ResourceEdgeTargetType = "artifact" | "skill" | "capability";

export interface ResourceGraphNode {
  id: string;
  ref: string;
  exposure: Exposure;
  overrides?: Record<string, unknown>;
  artifact: ArtifactDocument["frontmatter"];
  body: string;
  bodyPath?: string;
}

export interface ResourceGraphEdge {
  from: string;
  to: string;
  reason: ResourceEdgeReason;
  targetType: ResourceEdgeTargetType;
}

export interface ResourceGraph {
  profile: ProfileManifestV1;
  nodes: ResourceGraphNode[];
  edges: ResourceGraphEdge[];
  capabilities: ProfileCapabilityRef[];
  warnings: string[];
}

export interface BuildResourceGraphOptions {
  baseDir: string;
}

export async function buildResourceGraph(
  profile: ProfileManifestV1,
  options: BuildResourceGraphOptions,
): Promise<ResourceGraph> {
  const nodes: ResourceGraphNode[] = [];
  const edges: ResourceGraphEdge[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const ref of profile.artifacts) {
    const path = resolveInsideBaseDir(options.baseDir, ref.ref);
    if (!existsSync(path)) throw new Error(`Artifact not found: ${ref.ref}`);

    const artifact = parseArtifactMarkdown(await readFile(path, "utf8"), ref.ref);
    warnings.push(...artifact.warnings.map((warning) => `${ref.ref}: ${warning}`));
    const id = artifact.frontmatter.name;
    if (seen.has(id)) throw new Error(`Duplicate resource identity: ${id}`);
    seen.add(id);

    nodes.push({
      id,
      ref: ref.ref,
      exposure: ref.exposure ?? "embed",
      overrides: ref.overrides,
      artifact: artifact.frontmatter,
      body: artifact.body,
      bodyPath: path,
    });

    edges.push({ from: profile.name, to: id, reason: "reference", targetType: "artifact" });
    addRequiresEdges(edges, id, artifact.frontmatter.requires);
  }

  const capabilities = profile.capabilities ?? [];
  for (const capability of capabilities) {
    edges.push({ from: profile.name, to: capability.id, reason: "reference", targetType: "capability" });
  }

  assertArtifactDependenciesResolve(nodes, edges);
  warnings.push(...collectCapabilityWarnings(profile, capabilities, edges));

  return { profile, nodes, edges, capabilities, warnings };
}

function addRequiresEdges(
  edges: ResourceGraphEdge[],
  from: string,
  requires: ArtifactDocument["frontmatter"]["requires"],
): void {
  if (!requires) return;
  for (const skill of requires.skills ?? []) {
    edges.push({ from, to: skill, reason: "requires", targetType: "skill" });
  }
  for (const capability of requires.capabilities ?? []) {
    edges.push({ from, to: capability, reason: "requires", targetType: "capability" });
  }
  for (const artifact of requires.artifacts ?? []) {
    edges.push({ from, to: artifact, reason: "requires", targetType: "artifact" });
  }
}

function collectCapabilityWarnings(
  profile: ProfileManifestV1,
  capabilities: ProfileCapabilityRef[],
  edges: ResourceGraphEdge[],
): string[] {
  const declared = new Set(capabilities.map((capability) => capability.id));
  const warnings: string[] = [];
  for (const edge of edges) {
    if (edge.reason !== "requires" || edge.targetType !== "capability") continue;
    if (!declared.has(edge.to)) {
      warnings.push(`Capability dependency not declared: ${edge.to} required by ${edge.from}`);
    }
  }

  const targetNames = Object.keys(profile.targets ?? {});
  if (targetNames.length === 0) return warnings;

  for (const capability of capabilities) {
    if ((capability.privacy ?? "public") === "public" && capability.localPaths?.length) {
      warnings.push(`Capability ${capability.id} declares localPaths but is marked public`);
    }
  }

  for (const capability of capabilities) {
    if (!capability.targets || capability.targets.length === 0) continue;
    const supported = new Set(capability.targets);
    for (const targetName of targetNames) {
      if (!supported.has(targetName)) {
        warnings.push(`Capability ${capability.id} is not declared for target ${targetName}`);
      }
    }
  }

  return warnings;
}

function assertArtifactDependenciesResolve(nodes: ResourceGraphNode[], edges: ResourceGraphEdge[]): void {
  const knownArtifacts = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (edge.reason !== "requires" || edge.targetType !== "artifact") continue;
    if (!knownArtifacts.has(edge.to)) {
      throw new Error(`Artifact dependency not found: ${edge.to} required by ${edge.from}`);
    }
  }
}


function resolveInsideBaseDir(baseDir: string, ref: string): string {
  if (isAbsolute(ref) || posix.isAbsolute(ref) || win32.isAbsolute(ref) || ref.split(/[\\/]+/).includes("..")) {
    throw new Error(`Artifact ref must stay inside profile directory: ${ref}`);
  }

  const base = resolve(baseDir);
  const target = resolve(base, ref);
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Artifact ref must stay inside profile directory: ${ref}`);
  }
  return target;
}
