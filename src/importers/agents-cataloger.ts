import type { ArtifactDocument, ArtifactType } from "../domain/artifact";

export interface AgentsCatalog {
  artifacts: ArtifactDocument[];
  warnings: string[];
}

interface Section {
  title: string;
  body: string;
}

export function catalogAgentsMarkdown(source: string): AgentsCatalog {
  const sections = splitSecondLevelSections(source);
  const artifacts: ArtifactDocument[] = [];
  const warnings: string[] = [];

  const usedNames = new Map<string, number>();

  for (const section of sections) {
    const classification = classifySection(section.title);
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
      warnings: [],
    });
  }

  return { artifacts, warnings };
}

function splitSecondLevelSections(source: string): Section[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;
  let preamble = "";

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (!current && preamble.trim().length > 0) {
        sections.push({ title: "Preamble", body: preamble });
      }
      if (current) sections.push(current);
      current = { title: heading[1], body: "" };
      continue;
    }
    if (current) {
      current.body += `${line}\n`;
      continue;
    }
    if (!/^#\s+/.test(line)) preamble += `${line}\n`;
  }
  if (current) sections.push(current);
  if (!current && preamble.trim().length > 0) sections.push({ title: "Preamble", body: preamble });

  return sections.filter((section) => section.body.trim().length > 0);
}

function classifySection(title: string): { type: ArtifactType; ambiguous: boolean } {
  const normalized = title.toLowerCase();
  if (/(verification|test|qa|deploy|workflow)/.test(normalized)) return { type: "workflow", ambiguous: false };
  if (/(rule|safety|opencode|skill|discovery|language|commit)/.test(normalized)) {
    return { type: "rule", ambiguous: false };
  }
  if (/(product|architecture|context|direction|runtime|workspace)/.test(normalized)) {
    return { type: "context", ambiguous: false };
  }
  return { type: "context", ambiguous: true };
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
