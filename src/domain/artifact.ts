import { parse as parseYAML } from "yaml";

export type ArtifactType =
  | "rule"
  | "workflow"
  | "prompt"
  | "context"
  | "skill-ref"
  | "capability-ref";

export type Privacy = "public" | "private" | "local";
export type Exposure = "embed" | "mention" | "none";

export interface ArtifactRequires {
  skills?: string[];
  capabilities?: string[];
  artifacts?: string[];
}

export interface ArtifactFrontmatter {
  name: string;
  type: ArtifactType;
  description: string;
  tags?: string[];
  requires?: ArtifactRequires;
  privacy?: Privacy;
}

export interface ArtifactDocument {
  ref: string;
  frontmatter: ArtifactFrontmatter;
  body: string;
  warnings: string[];
}

const artifactTypes = new Set<ArtifactType>([
  "rule",
  "workflow",
  "prompt",
  "context",
  "skill-ref",
  "capability-ref",
]);

const privacyValues = new Set<Privacy>(["public", "private", "local"]);
const targetSpecificFields = new Set([
  "agent",
  "allowed-tools",
  "argument-hint",
  "model",
  "mode",
  "permission",
  "permissions",
  "tools",
]);

export function parseArtifactMarkdown(raw: string, ref: string): ArtifactDocument {
  const { meta, body } = splitFrontmatter(raw);
  const warnings = collectMetadataWarnings(meta);
  const frontmatter = normalizeFrontmatter(meta, ref);
  const normalizedBody = body.trim();
  if (frontmatter.type === "workflow" && !isProceduralMarkdown(normalizedBody)) {
    throw new Error(`Workflow artifact ${ref} must contain procedural Markdown.`);
  }

  return {
    ref,
    frontmatter,
    body: normalizedBody,
    warnings,
  };
}

function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const fenceRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = fenceRe.exec(raw);
  if (!match) {
    throw new Error("Artifact is missing YAML frontmatter.");
  }

  const parsed = parseYAML(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Artifact frontmatter must be a YAML object.");
  }

  return {
    meta: parsed as Record<string, unknown>,
    body: raw.slice(match[0].length),
  };
}

function collectMetadataWarnings(meta: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(meta)) {
    if (targetSpecificFields.has(key)) {
      warnings.push(`target-specific field "${key}" should live in adapter overrides`);
    }
  }
  return warnings;
}

function normalizeFrontmatter(meta: Record<string, unknown>, ref: string): ArtifactFrontmatter {
  const name = requireString(meta.name, `Artifact ${ref} frontmatter.name`);
  const type = requireArtifactType(meta.type, `Artifact ${ref} frontmatter.type`);
  const description = requireString(meta.description, `Artifact ${ref} frontmatter.description`);
  const out: ArtifactFrontmatter = { name, type, description };

  if (meta.tags !== undefined) out.tags = requireStringArray(meta.tags, `Artifact ${ref} frontmatter.tags`);
  if (meta.requires !== undefined) out.requires = normalizeRequires(meta.requires, ref);
  if (meta.privacy !== undefined) out.privacy = requirePrivacy(meta.privacy, `Artifact ${ref} frontmatter.privacy`);

  return out;
}

function normalizeRequires(value: unknown, ref: string): ArtifactRequires {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Artifact ${ref} frontmatter.requires must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const out: ArtifactRequires = {};
  if (raw.skills !== undefined) out.skills = requireStringArray(raw.skills, `Artifact ${ref} frontmatter.requires.skills`);
  if (raw.capabilities !== undefined) {
    out.capabilities = requireStringArray(raw.capabilities, `Artifact ${ref} frontmatter.requires.capabilities`);
  }
  if (raw.artifacts !== undefined) {
    out.artifacts = requireStringArray(raw.artifacts, `Artifact ${ref} frontmatter.requires.artifacts`);
  }
  return out;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function requireArtifactType(value: unknown, label: string): ArtifactType {
  if (typeof value !== "string" || !artifactTypes.has(value as ArtifactType)) {
    throw new Error(`${label} must be one of: ${Array.from(artifactTypes).join(", ")}.`);
  }
  return value as ArtifactType;
}

function requirePrivacy(value: unknown, label: string): Privacy {
  if (typeof value !== "string" || !privacyValues.has(value as Privacy)) {
    throw new Error(`${label} must be one of: public, private, local.`);
  }
  return value as Privacy;
}

function isProceduralMarkdown(body: string): boolean {
  return [
    /^\s*\d+\.\s+\S+/m,
    /^\s*[-*]\s+\S+/m,
    /^\s*[-*]\s*\[[ xX]\]\s+\S+/m,
    /^#{1,6}\s+(Steps?|Procedure|Workflow|Decision Tree|Checklist)\b/im,
    /\b(use|run|execute):\s*\n\s*```/im,
  ].some((pattern) => pattern.test(body));
}
