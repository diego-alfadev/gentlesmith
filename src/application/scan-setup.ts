import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { catalogAgentsMarkdown } from "../importers/agents-cataloger";

export type SourceKind = "personal-system" | "project-overlay" | "generated" | "unknown";
export type ScanConfidence = "high" | "medium" | "low";
export type SectionDisposition = "import" | "exclude" | "review";

export interface ScanSetupInput {
  cwd?: string;
  homeDir?: string;
  extraPaths?: string[];
}

export interface SourceSectionSummary {
  title: string;
  disposition: SectionDisposition;
  reason: string;
}

export interface SourceCandidate {
  path: string;
  kind: SourceKind;
  confidence: ScanConfidence;
  recommended: boolean;
  reason: string;
  notes: string[];
  sections: {
    import: number;
    exclude: number;
    review: number;
    items: SourceSectionSummary[];
  };
}

export interface ScanSetupResult {
  cwd: string;
  homeDir: string;
  candidates: SourceCandidate[];
  warnings: string[];
}

const GENERATED_MARKERS = [
  "gentle-ai-overlay:gentlesmith",
  "<!-- fragment:",
  "agent.gentlesmith-",
];

const KNOWN_PERSONAL_FILES = [
  ".codex/AGENTS.md",
  ".codex/agents.md",
  ".claude/CLAUDE.md",
  ".claude/AGENTS.md",
  ".config/opencode/AGENTS.md",
  ".gemini/AGENTS.md",
  ".gemini/GEMINI.md",
];

export async function scanAgentSetup(input: ScanSetupInput = {}): Promise<ScanSetupResult> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const homeDir = resolve(input.homeDir ?? process.env.HOME ?? cwd);
  const candidatePaths = uniquePaths([
    ...KNOWN_PERSONAL_FILES.map((path) => join(homeDir, path)),
    join(cwd, "AGENTS.md"),
    join(cwd, "CLAUDE.md"),
    ...(input.extraPaths ?? []),
  ].map((path) => resolve(path)));

  const candidates: SourceCandidate[] = [];
  const warnings: string[] = [];
  const seenContent = new Map<string, string>();

  for (const path of candidatePaths) {
    if (!existsSync(path)) continue;
    try {
      const source = await readFile(path, "utf8");
      const digest = createHash("sha256").update(source).digest("hex");
      const duplicateOf = seenContent.get(digest);
      if (duplicateOf) {
        warnings.push(`skipped duplicate source ${path}; same content as ${duplicateOf}`);
        continue;
      }
      seenContent.set(digest, path);
      candidates.push(classifySource(path, source, { cwd, homeDir }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`could not read ${path}: ${message}`);
    }
  }

  return { cwd, homeDir, candidates, warnings };
}

function classifySource(path: string, source: string, roots: { cwd: string; homeDir: string }): SourceCandidate {
  const generated = GENERATED_MARKERS.some((marker) => source.includes(marker));
  const personal = isKnownPersonalPath(path, roots.homeDir);
  const project = isInside(path, roots.cwd) && ["AGENTS.md", "CLAUDE.md"].includes(basename(path));
  const catalog = catalogAgentsMarkdown(source);
  const sections: SourceSectionSummary[] = [
    ...catalog.artifacts.map((artifact) => ({
      title: artifact.frontmatter.description.replace(/^Cataloged AGENTS\.md section: /, ""),
      disposition: artifact.warnings.some((warning) => warning.includes("review")) ? "review" as const : "import" as const,
      reason: artifact.frontmatter.type,
    })),
    ...catalog.skipped.map((section) => ({
      title: section.title,
      disposition: section.disposition,
      reason: section.reason,
    })),
  ];

  if (generated) {
    const generatedSections = sections.map((section) => ({
      ...section,
      disposition: "review" as const,
      reason: "generated output",
    }));
    return {
      path,
      kind: "generated",
      confidence: "high",
      recommended: false,
      reason: "contains Gentlesmith/gentle-ai managed markers",
      notes: ["Do not import generated output as the source of truth."],
      sections: countSections(generatedSections),
    };
  }

  if (personal) {
    return {
      path,
      kind: "personal-system",
      confidence: "high",
      recommended: true,
      reason: "known global agent instructions location",
      notes: catalog.skipped.length > 0 ? ["Some transient-looking sections would be excluded by default."] : [],
      sections: countSections(sections),
    };
  }

  if (project) {
    return {
      path,
      kind: "project-overlay",
      confidence: "medium",
      recommended: false,
      reason: "agent instructions file inside the current workspace",
      notes: ["Project overlays are not the primary import target yet."],
      sections: countSections(sections),
    };
  }

  return {
    path,
    kind: "unknown",
    confidence: "low",
    recommended: false,
    reason: "not in a known personal/system or project overlay location",
    notes: [],
    sections: countSections(sections),
  };
}

function countSections(items: SourceSectionSummary[]): SourceCandidate["sections"] {
  return {
    import: items.filter((item) => item.disposition === "import").length,
    exclude: items.filter((item) => item.disposition === "exclude").length,
    review: items.filter((item) => item.disposition === "review").length,
    items,
  };
}

function isKnownPersonalPath(path: string, homeDir: string): boolean {
  const relativePath = relative(homeDir, path).replace(/\\/g, "/");
  return KNOWN_PERSONAL_FILES.includes(relativePath);
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}
