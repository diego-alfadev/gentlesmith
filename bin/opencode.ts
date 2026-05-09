#!/usr/bin/env bun

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { resolveUserPath, type ProfileSpec } from "./runtime";

export interface OpenCodeAgentPlan {
  configPath: string;
  agentKey: string;
  changeType: "create-config" | "create-agent" | "update-agent" | "noop";
  finalContent: string;
}

export interface OpenCodeProfileInput {
  profile: ProfileSpec;
  prompt: string;
}

export interface OpenCodeProfilesPlan {
  configPath: string;
  agentKeys: string[];
  prunedAgentKeys: string[];
  defaultAgentKey?: string;
  changeType: "create-config" | "update-config" | "noop";
  finalContent: string;
}

interface OpenCodeConfig {
  default_agent?: string;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function planOpenCodeProfileAgent(
  destination: string,
  profile: ProfileSpec,
  prompt: string,
): Promise<OpenCodeAgentPlan> {
  const configPath = resolveUserPath(destination);
  const agentKey = profileToAgentKey(profile.name);
  const entry = {
    description: `Gentlesmith profile: ${profile.name}`,
    mode: "primary",
    prompt,
    tools: {
      bash: true,
      edit: true,
      read: true,
      write: true,
    },
  };

  let config: OpenCodeConfig = {};
  let changeType: OpenCodeAgentPlan["changeType"] = "create-config";
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf8");
    try {
      config = JSON.parse(raw) as OpenCodeConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenCode config is not valid JSON: ${configPath} (${message})`);
    }
    const current = config.agent?.[agentKey];
    changeType = current === undefined
      ? "create-agent"
      : JSON.stringify(current) === JSON.stringify(entry)
        ? "noop"
        : "update-agent";
  }

  config.agent = {
    ...(isPlainObject(config.agent) ? config.agent : {}),
    [agentKey]: entry,
  };

  return {
    configPath,
    agentKey,
    changeType,
    finalContent: `${JSON.stringify(config, null, 2)}\n`,
  };
}

export async function planOpenCodeProfiles(
  destination: string,
  profiles: OpenCodeProfileInput[],
  options: { defaultProfileName?: string } = {},
): Promise<OpenCodeProfilesPlan> {
  const configPath = resolveUserPath(destination);
  const before = await readOpenCodeConfig(configPath);
  const config = structuredClone(before);
  const agent = isPlainObject(config.agent) ? { ...config.agent } : {};
  const agentKeys: string[] = [];
  const desiredAgentKeys = new Set<string>();

  for (const { profile, prompt } of profiles) {
    const agentKey = profileToAgentKey(profile.name);
    if (desiredAgentKeys.has(agentKey)) {
      throw new Error(`OpenCode agent key collision for profile "${profile.name}": ${agentKey}`);
    }
    desiredAgentKeys.add(agentKey);
    agentKeys.push(agentKey);
    agent[agentKey] = buildAgentEntry(profile, prompt);
  }

  const prunedAgentKeys: string[] = [];
  for (const key of Object.keys(agent)) {
    if (!key.startsWith("gentlesmith-")) continue;
    if (desiredAgentKeys.has(key)) continue;
    delete agent[key];
    prunedAgentKeys.push(key);
  }

  config.agent = agent;

  let defaultAgentKey: string | undefined;
  if (options.defaultProfileName) {
    defaultAgentKey = profileToAgentKey(options.defaultProfileName);
    config.default_agent = defaultAgentKey;
  } else if (
    typeof config.default_agent === "string" &&
    config.default_agent.startsWith("gentlesmith-") &&
    !desiredAgentKeys.has(config.default_agent)
  ) {
    delete config.default_agent;
  }

  const finalContent = `${JSON.stringify(config, null, 2)}\n`;
  const initialContent = existsSync(configPath) ? `${JSON.stringify(before, null, 2)}\n` : "";
  const changeType: OpenCodeProfilesPlan["changeType"] = !existsSync(configPath)
    ? "create-config"
    : initialContent === finalContent
      ? "noop"
      : "update-config";

  return {
    configPath,
    agentKeys,
    prunedAgentKeys,
    defaultAgentKey,
    changeType,
    finalContent,
  };
}

export async function applyOpenCodeAgentPlan(plan: OpenCodeAgentPlan): Promise<void> {
  if (plan.changeType === "noop") return;
  await mkdir(dirname(plan.configPath), { recursive: true });
  const tempPath = `${plan.configPath}.gentlesmith.tmp`;
  await writeFile(tempPath, plan.finalContent, "utf8");
  await rename(tempPath, plan.configPath);
}

export async function applyOpenCodeProfilesPlan(plan: OpenCodeProfilesPlan): Promise<void> {
  if (plan.changeType === "noop") return;
  await mkdir(dirname(plan.configPath), { recursive: true });
  const tempPath = `${plan.configPath}.gentlesmith.tmp`;
  await writeFile(tempPath, plan.finalContent, "utf8");
  await rename(tempPath, plan.configPath);
}

export async function purgeOpenCodeProfileAgent(destination: string, profileName: string): Promise<boolean> {
  const configPath = resolveUserPath(destination);
  if (!existsSync(configPath)) return false;

  const raw = await readFile(configPath, "utf8");
  let config: OpenCodeConfig;
  try {
    config = JSON.parse(raw) as OpenCodeConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenCode config is not valid JSON: ${configPath} (${message})`);
  }

  const agentKey = profileToAgentKey(profileName);
  if (!isPlainObject(config.agent) || config.agent[agentKey] === undefined) return false;

  delete config.agent[agentKey];
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.gentlesmith.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
  return true;
}

export async function purgeOpenCodeGentlesmithAgents(destination: string): Promise<boolean> {
  const configPath = resolveUserPath(destination);
  if (!existsSync(configPath)) return false;

  const config = await readOpenCodeConfig(configPath);
  if (!isPlainObject(config.agent)) return false;

  let changed = false;
  for (const key of Object.keys(config.agent)) {
    if (key.startsWith("gentlesmith-")) {
      delete config.agent[key];
      changed = true;
    }
  }
  if (typeof config.default_agent === "string" && config.default_agent.startsWith("gentlesmith-")) {
    delete config.default_agent;
    changed = true;
  }
  if (!changed) return false;

  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.gentlesmith.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
  return true;
}

export function summarizeOpenCodeAgentPlan(plan: OpenCodeAgentPlan, apply: boolean): void {
  const verb = apply ? "WRITE" : "WOULD";
  const action = plan.changeType === "noop"
    ? "NO CHANGES"
    : `${verb} ${plan.changeType.replace("-", " ").toUpperCase()}`;
  console.log(`\n━━━ opencode selectable profile (${plan.agentKey}) ━━━`);
  console.log(`  destination:  ${plan.configPath}`);
  console.log(`  action:       ${action}`);
  console.log("  owns:         agent.gentlesmith-* only");
}

export function summarizeOpenCodeProfilesPlan(plan: OpenCodeProfilesPlan, apply: boolean): void {
  const verb = apply ? "WRITE" : "WOULD";
  const action = plan.changeType === "noop"
    ? "NO CHANGES"
    : `${verb} ${plan.changeType.replace("-", " ").toUpperCase()}`;
  console.log(`\n━━━ opencode profiles (${plan.agentKeys.length}) ━━━`);
  console.log(`  destination:   ${plan.configPath}`);
  console.log(`  action:        ${action}`);
  console.log(`  agents:        ${plan.agentKeys.join(", ")}`);
  if (plan.prunedAgentKeys.length > 0) console.log(`  pruned:        ${plan.prunedAgentKeys.join(", ")}`);
  if (plan.defaultAgentKey) console.log(`  default_agent: ${plan.defaultAgentKey}`);
  console.log("  owns:          agent.gentlesmith-* and default_agent only when set to gentlesmith-*");
}

export function profileToAgentKey(profileName: string): string {
  const slug = profileName
    .replace(/^local-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `gentlesmith-${slug || "profile"}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOpenCodeConfig(configPath: string): Promise<OpenCodeConfig> {
  if (!existsSync(configPath)) return {};

  const raw = await readFile(configPath, "utf8");
  try {
    return JSON.parse(raw) as OpenCodeConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenCode config is not valid JSON: ${configPath} (${message})`);
  }
}

function buildAgentEntry(profile: ProfileSpec, prompt: string): Record<string, unknown> {
  return {
    description: `Gentlesmith profile: ${profile.name}`,
    mode: "primary",
    prompt,
    tools: {
      bash: true,
      edit: true,
      read: true,
      write: true,
    },
  };
}
