#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYAML } from "yaml";
import { resolveUserPath, type RuntimePaths } from "./runtime";

export interface ToolHit {
  detected: boolean;
  command?: string;
  path?: string;
  version?: string;
  reason: string;
}

export interface AgentHit {
  detected: boolean;
  command?: string;
  configPath?: string;
  reason: string;
}

export interface SkillHit {
  name: string;
  root: string;
  path: string;
  source: "opencode" | "codex" | "claude" | "agents" | "skills-sh";
}

export interface DiscoverySnapshot {
  tools: {
    gentleAi: ToolHit;
    engram: ToolHit;
    context7: ToolHit;
    gga: ToolHit;
    skillsCli: ToolHit;
  };
  agents: {
    opencode: AgentHit;
    codex: AgentHit;
    claude: AgentHit;
    gemini: AgentHit;
    cursor: AgentHit;
  };
  skills: SkillHit[];
  recommendations: {
    fragments: string[];
    targets: string[];
    skills: string[];
    warnings: string[];
  };
}

export async function discoverRuntime(paths: RuntimePaths): Promise<DiscoverySnapshot> {
  const tools = {
    gentleAi: commandTool("gentle-ai", "gentle-ai CLI found in PATH"),
    engram: commandTool("engram", "Engram CLI found in PATH", existsSync(join(homedir(), ".engram"))),
    context7: await detectContext7(),
    gga: commandTool("gga", "GGA CLI found in PATH"),
    skillsCli: commandTool("skills", "skills CLI found in PATH"),
  };

  const agents = {
    opencode: agentHit("opencode", join(homedir(), ".config/opencode/opencode.json"), "OpenCode config or CLI detected"),
    codex: agentHit("codex", join(homedir(), ".codex"), "Codex config or CLI detected"),
    claude: agentHit("claude", join(homedir(), ".claude"), "Claude config or CLI detected"),
    gemini: agentHit("gemini", join(homedir(), ".gemini"), "Gemini config or CLI detected"),
    cursor: agentHit("cursor", join(homedir(), ".cursor"), "Cursor config or CLI detected"),
  };

  const skills = await discoverSkills();
  const recommendations = buildRecommendations(paths, tools, agents, skills);
  return { tools, agents, skills, recommendations };
}

export function summarizeDiscovery(snapshot: DiscoverySnapshot): string[] {
  const lines: string[] = [];
  const detectedTools = Object.entries(snapshot.tools)
    .filter(([, hit]) => hit.detected)
    .map(([name, hit]) => `${name}${hit.version ? ` ${hit.version}` : ""}`);
  const detectedAgents = Object.entries(snapshot.agents)
    .filter(([, hit]) => hit.detected)
    .map(([name]) => name);

  lines.push(`tools: ${detectedTools.length ? detectedTools.join(", ") : "none detected"}`);
  lines.push(`agents: ${detectedAgents.length ? detectedAgents.join(", ") : "none detected"}`);
  lines.push(`skills: ${snapshot.skills.length} discovered`);
  if (snapshot.recommendations.fragments.length) lines.push(`fragments: ${snapshot.recommendations.fragments.join(", ")}`);
  if (snapshot.recommendations.targets.length) lines.push(`targets: ${snapshot.recommendations.targets.join(", ")}`);
  for (const warning of snapshot.recommendations.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

function commandTool(command: string, reason: string, stateDetected = false): ToolHit {
  const path = commandPath(command);
  const detected = Boolean(path) || stateDetected;
  return {
    detected,
    command,
    path,
    version: path ? commandVersion(command) : undefined,
    reason: detected ? reason : `${command} not found`,
  };
}

function commandPath(command: string): string | undefined {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function commandVersion(command: string): string | undefined {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 1500 });
  if (result.status !== 0) return undefined;
  return stripAnsi(result.stdout).trim().split(/\s+/).slice(0, 3).join(" ") || undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function agentHit(command: string, configPath: string, reason: string): AgentHit {
  const path = commandPath(command);
  const configExists = existsSync(resolveUserPath(configPath));
  return {
    detected: Boolean(path) || configExists,
    command,
    configPath,
    reason: Boolean(path) || configExists ? reason : `${command} not detected`,
  };
}

async function detectContext7(): Promise<ToolHit> {
  const opencodeConfig = join(homedir(), ".config/opencode/opencode.json");
  if (existsSync(opencodeConfig)) {
    try {
      const parsed = JSON.parse(await readFile(opencodeConfig, "utf8")) as { mcp?: Record<string, unknown> };
      if (parsed.mcp?.context7) {
        return { detected: true, reason: "Context7 MCP configured in OpenCode", path: opencodeConfig };
      }
    } catch {
      return { detected: false, reason: "OpenCode config exists but could not be parsed for Context7", path: opencodeConfig };
    }
  }
  return { detected: false, reason: "Context7 MCP not detected" };
}

async function discoverSkills(): Promise<SkillHit[]> {
  const roots: Array<{ source: SkillHit["source"]; root: string }> = [
    { source: "opencode", root: join(homedir(), ".config/opencode/skills") },
    { source: "codex", root: join(homedir(), ".codex/skills") },
    { source: "claude", root: join(homedir(), ".claude/skills") },
    { source: "agents", root: join(homedir(), ".agents/skills") },
    { source: "skills-sh", root: join(homedir(), ".skills") },
  ];

  const out: SkillHit[] = [];
  const seen = new Set<string>();
  for (const { source, root } of roots) {
    if (!existsSync(root)) continue;
    for (const skill of await collectSkillDirs(root)) {
      const key = `${source}:${skill.name}:${skill.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source, root, ...skill });
    }
  }
  return out.sort((a, b) => `${a.source}/${a.name}`.localeCompare(`${b.source}/${b.name}`));
}

async function collectSkillDirs(root: string): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillPath = join(root, entry.name, "SKILL.md");
    if (existsSync(skillPath)) out.push({ name: entry.name, path: skillPath });
  }
  return out;
}

function buildRecommendations(
  paths: RuntimePaths,
  tools: DiscoverySnapshot["tools"],
  agents: DiscoverySnapshot["agents"],
  skills: SkillHit[],
): DiscoverySnapshot["recommendations"] {
  const fragments: string[] = [];
  const targets: string[] = [];
  const warnings: string[] = [];

  maybePushFragment(paths, fragments, "integrations/engram", tools.engram.detected);
  maybePushFragment(paths, fragments, "integrations/context7", tools.context7.detected);
  maybePushFragment(paths, fragments, "integrations/sdd", tools.gentleAi.detected || tools.gga.detected || hasSddSkills(skills));

  if (agents.opencode.detected) targets.push("opencode");
  if (agents.codex.detected) targets.push("codex");
  if (agents.claude.detected) targets.push("claude");
  if (agents.gemini.detected) targets.push("antigravity");
  if (agents.cursor.detected) targets.push("cursor");
  if (targets.length === 0) targets.push("codex");

  if (!tools.gentleAi.detected) warnings.push("gentle-ai not detected; running in standalone mode");
  if (tools.context7.reason.includes("could not be parsed")) warnings.push(tools.context7.reason);

  return {
    fragments: unique(fragments),
    targets: unique(targets),
    skills: unique(skills.map((skill) => skill.name)),
    warnings,
  };
}

function maybePushFragment(paths: RuntimePaths, fragments: string[], ref: string, condition: boolean): void {
  if (!condition) return;
  if (existsSync(join(paths.builtInFragmentsDir, `${ref}.md`)) || existsSync(join(paths.localFragmentsDir, `${ref}.md`))) {
    fragments.push(ref);
  }
}

function hasSddSkills(skills: SkillHit[]): boolean {
  return skills.some((skill) => ["sdd-init", "sdd-apply", "sdd-verify"].includes(skill.name));
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
