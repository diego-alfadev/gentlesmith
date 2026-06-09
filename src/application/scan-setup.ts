import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { catalogAgentsMarkdown } from "../importers/agents-cataloger";

export type SourceKind = "personal-system" | "project-overlay" | "generated" | "unknown";
export type ScanConfidence = "high" | "medium" | "low";
export type SectionDisposition = "import" | "exclude" | "review";
export type CapabilityKind = "mcp" | "plugin" | "hook" | "agent" | "config";

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

export interface CapabilityCandidate {
  id: string;
  kind: CapabilityKind;
  target: string;
  sourcePath: string;
  status: "detected";
  detail?: string;
}

export interface ScanSetupResult {
  cwd: string;
  homeDir: string;
  candidates: SourceCandidate[];
  capabilities: CapabilityCandidate[];
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

  const rankedCandidates = markRecommendedSource(candidates);
  const capabilityResult = await detectCapabilities({ cwd, homeDir });
  warnings.push(...capabilityResult.warnings);

  return { cwd, homeDir, candidates: rankedCandidates, capabilities: capabilityResult.capabilities, warnings };
}

function markRecommendedSource(candidates: SourceCandidate[]): SourceCandidate[] {
  const recommended = candidates.find((candidate) =>
    candidate.kind === "personal-system" &&
    candidate.confidence === "high" &&
    candidate.sections.import > 0
  );

  return candidates.map((candidate) => ({
    ...candidate,
    recommended: Boolean(recommended && candidate.path === recommended.path),
  }));
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
      recommended: false,
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


async function detectCapabilities(roots: { cwd: string; homeDir: string }): Promise<{ capabilities: CapabilityCandidate[]; warnings: string[] }> {
  const capabilities: CapabilityCandidate[] = [];
  const warnings: string[] = [];

  await collectCodexCapabilities(roots.homeDir, capabilities, warnings);
  await collectClaudeCapabilities(roots.homeDir, capabilities, warnings);
  await collectGeminiCapabilities(roots.homeDir, capabilities, warnings);
  await collectOpenCodeCapabilities(roots.homeDir, capabilities, warnings);

  return { capabilities: dedupeCapabilities(capabilities), warnings };
}

async function collectCodexCapabilities(homeDir: string, capabilities: CapabilityCandidate[], warnings: string[]): Promise<void> {
  const path = join(homeDir, ".codex", "config.toml");
  const raw = await readOptional(path, warnings);
  if (!raw) return;

  for (const match of raw.matchAll(/^\[mcp_servers\.([a-zA-Z0-9_-]+)\]/gm)) {
    capabilities.push({ id: match[1], kind: "mcp", target: "codex", sourcePath: path, status: "detected" });
  }
  for (const match of raw.matchAll(/^\[plugins\."([^"]+)"\]/gm)) {
    capabilities.push({ id: match[1], kind: "plugin", target: "codex", sourcePath: path, status: "detected" });
  }
  if (/^notify\s*=\s*\[/m.test(raw)) {
    capabilities.push({ id: "notify", kind: "hook", target: "codex", sourcePath: path, status: "detected", detail: "turn-ended notification command" });
  }
}

async function collectClaudeCapabilities(homeDir: string, capabilities: CapabilityCandidate[], warnings: string[]): Promise<void> {
  const settingsPath = join(homeDir, ".claude", "settings.json");
  const settings = await readJsonObject(settingsPath, warnings);
  if (settings) {
    const enabledPlugins = objectAt(settings, "enabledPlugins");
    for (const id of Object.keys(enabledPlugins ?? {})) {
      if (enabledPlugins?.[id] === true) capabilities.push({ id, kind: "plugin", target: "claude", sourcePath: settingsPath, status: "detected" });
    }
    const hooks = objectAt(settings, "hooks");
    for (const id of Object.keys(hooks ?? {})) {
      capabilities.push({ id, kind: "hook", target: "claude", sourcePath: settingsPath, status: "detected" });
    }
  }

  const mcpDir = join(homeDir, ".claude", "mcp");
  try {
    const entries = await readdir(mcpDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        capabilities.push({ id: entry.name.replace(/\.json$/, ""), kind: "mcp", target: "claude", sourcePath: join(mcpDir, entry.name), status: "detected" });
      }
    }
  } catch (err) {
    if (!isNotFound(err)) warnings.push(`could not inspect ${mcpDir}: ${errorMessage(err)}`);
  }
}

async function collectGeminiCapabilities(homeDir: string, capabilities: CapabilityCandidate[], warnings: string[]): Promise<void> {
  const paths = [
    join(homeDir, ".gemini", "settings.json"),
    join(homeDir, ".gemini", "config", "mcp_config.json"),
    join(homeDir, ".gemini", "antigravity-cli", "mcp_config.json"),
    join(homeDir, ".gemini", "antigravity-ide", "mcp_config.json"),
  ];

  for (const path of paths) {
    const json = await readJsonObject(path, warnings);
    if (!json) continue;
    const mcpServers = objectAt(json, "mcpServers");
    for (const id of Object.keys(mcpServers ?? {})) {
      capabilities.push({ id, kind: "mcp", target: "gemini", sourcePath: path, status: "detected" });
    }
  }
}

async function collectOpenCodeCapabilities(homeDir: string, capabilities: CapabilityCandidate[], warnings: string[]): Promise<void> {
  const path = join(homeDir, ".config", "opencode", "opencode.json");
  const json = await readJsonObject(path, warnings);
  if (!json) return;

  const agents = objectAt(json, "agent");
  for (const id of Object.keys(agents ?? {})) {
    capabilities.push({ id, kind: "agent", target: "opencode", sourcePath: path, status: "detected" });
  }
  const mcp = objectAt(json, "mcp") ?? objectAt(json, "mcpServers");
  for (const id of Object.keys(mcp ?? {})) {
    capabilities.push({ id, kind: "mcp", target: "opencode", sourcePath: path, status: "detected" });
  }
}

async function readOptional(path: string, warnings: string[]): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    warnings.push(`could not read ${path}: ${errorMessage(err)}`);
    return undefined;
  }
}

async function readJsonObject(path: string, warnings: string[]): Promise<Record<string, unknown> | undefined> {
  const raw = await readOptional(path, warnings);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch (err) {
    warnings.push(`could not parse ${path}: ${errorMessage(err)}`);
    return undefined;
  }
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const found = value[key];
  return found && typeof found === "object" && !Array.isArray(found) ? found as Record<string, unknown> : undefined;
}

function dedupeCapabilities(capabilities: CapabilityCandidate[]): CapabilityCandidate[] {
  const seen = new Set<string>();
  const result: CapabilityCandidate[] = [];
  for (const capability of capabilities) {
    const key = `${capability.target}:${capability.kind}:${capability.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result.sort((a, b) => `${a.target}:${a.kind}:${a.id}`.localeCompare(`${b.target}:${b.kind}:${b.id}`));
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
