import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type CapabilityKind = "mcp" | "plugin" | "hook" | "agent" | "config";

export interface CapabilityCandidate {
  id: string;
  kind: CapabilityKind;
  target: string;
  sourcePath: string;
  status: "detected";
  detail?: string;
}

export async function detectCapabilities(roots: { homeDir: string }): Promise<{ capabilities: CapabilityCandidate[]; warnings: string[] }> {
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
