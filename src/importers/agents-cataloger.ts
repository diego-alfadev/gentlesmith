import type { ArtifactDocument, ArtifactType } from "../domain/artifact";

export type CatalogDisposition = "import" | "exclude" | "review";

export interface AgentsCatalog {
  artifacts: ArtifactDocument[];
  skipped: CatalogSkippedSection[];
  warnings: string[];
}

export interface CatalogSkippedSection {
  title: string;
  disposition: Exclude<CatalogDisposition, "import">;
  reason: string;
}

interface Section {
  title: string;
  body: string;
  protectedBlock?: boolean;
}

export function catalogAgentsMarkdown(source: string): AgentsCatalog {
  const sections = splitCatalogSections(source);
  const artifacts: ArtifactDocument[] = [];
  const skipped: CatalogSkippedSection[] = [];
  const warnings: string[] = [];

  const usedNames = new Map<string, number>();

  for (const section of sections) {
    const classification = classifySection(section);
    if (classification.disposition !== "import") {
      skipped.push({
        title: section.title,
        disposition: classification.disposition,
        reason: classification.reason,
      });
      warnings.push(`section "${section.title}" ${classification.disposition === "exclude" ? "excluded" : "needs review"}: ${classification.reason}`);
      continue;
    }
    if (classification.ambiguous) {
      warnings.push(`section "${section.title}" cataloged as context because no stronger type matched`);
    }
    const name = uniqueName(slugify(section.title) || "section", usedNames);
    artifacts.push({
      ref: `agents-md/${name}.md`,
      frontmatter: {
        name,
        type: classification.type,
        description: `Cataloged AGENTS.md section: ${section.title}`,
        privacy: "private",
      },
      body: `## ${section.title}\n\n${section.body.trim()}`.trim(),
      warnings: classification.ambiguous ? ["review: ambiguous section type"] : [],
    });
  }

  return { artifacts, skipped, warnings };
}

function splitCatalogSections(source: string): Section[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;
  let preamble = "";

  for (let index = 0; index < lines.length; index += 1) {
    const protectedStart = /^<!--\s*gentle-ai:([a-z0-9-]+)\s*-->\s*$/.exec(lines[index]);
    if (protectedStart) {
      if (!current && preamble.trim().length > 0) {
        sections.push({ title: "Preamble", body: preamble });
        preamble = "";
      }
      if (current) {
        sections.push(current);
        current = null;
      }

      const blockLines = [lines[index]];
      const close = new RegExp(`^<!--\\s*/gentle-ai:${escapeRegExp(protectedStart[1])}\\s*-->\\s*$`);
      while (index + 1 < lines.length) {
        index += 1;
        blockLines.push(lines[index]);
        if (close.test(lines[index])) break;
      }
      sections.push(sectionFromProtectedBlock(protectedStart[1], blockLines));
      continue;
    }

    const heading = /^##\s+(.+?)\s*$/.exec(lines[index]);
    if (heading) {
      if (!current && preamble.trim().length > 0) {
        sections.push({ title: "Preamble", body: preamble });
        preamble = "";
      }
      if (current) sections.push(current);
      current = { title: heading[1], body: "" };
      continue;
    }
    if (current) {
      current.body += `${lines[index]}\n`;
      continue;
    }
    if (!/^#\s+/.test(lines[index])) preamble += `${lines[index]}\n`;
  }
  if (current) sections.push(current);
  if (!current && preamble.trim().length > 0) sections.push({ title: "Preamble", body: preamble });

  return sections.filter((section) => section.body.trim().length > 0);
}

function sectionFromProtectedBlock(markerName: string, blockLines: string[]): Section {
  let title = humanizeMarker(markerName);
  let headingIndex = -1;
  for (const [index, line] of blockLines.entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(line) ?? /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      title = heading[1];
      headingIndex = index;
      break;
    }
  }

  const bodyLines = headingIndex >= 0
    ? [...blockLines.slice(0, headingIndex), ...blockLines.slice(headingIndex + 1)]
    : blockLines;

  return {
    title,
    body: bodyLines.join("\n"),
    protectedBlock: true,
  };
}

function classifySection(section: Section): { type: ArtifactType; ambiguous: boolean; disposition: CatalogDisposition; reason: string } {
  const normalized = section.title.toLowerCase().trim();
  if (!section.protectedBlock && isTransientTitle(normalized)) {
    return {
      type: "context",
      ambiguous: false,
      disposition: "exclude",
      reason: "looks like session/runtime state rather than durable profile behavior",
    };
  }
  if (/(verification|test|qa|deploy|workflow|orchestrator|sdd)/.test(normalized)) {
    return { type: "workflow", ambiguous: false, disposition: "import", reason: "procedural or workflow-like section" };
  }
  if (/(rule|safety|opencode|skill|discovery|language|commit|protocol|memory|engram)/.test(normalized)) {
    return { type: "rule", ambiguous: false, disposition: "import", reason: "rule or protocol section" };
  }
  if (/(product|architecture|context|direction|runtime|workspace|persona|personality|tone|philosophy|expertise|behavior)/.test(normalized)) {
    return { type: "context", ambiguous: false, disposition: "import", reason: "context or persona section" };
  }
  return { type: "context", ambiguous: true, disposition: "import", reason: "no stronger type matched" };
}

function isTransientTitle(normalizedTitle: string): boolean {
  return [
    "goal",
    "instructions",
    "discoveries",
    "accomplished",
    "next steps",
    "next-steps",
    "relevant files",
    "relevant-files",
  ].includes(normalizedTitle);
}

function uniqueName(base: string, usedNames: Map<string, number>): string {
  const count = usedNames.get(base) ?? 0;
  usedNames.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanizeMarker(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
