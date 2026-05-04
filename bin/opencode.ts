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

interface OpenCodeConfig {
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

export async function applyOpenCodeAgentPlan(plan: OpenCodeAgentPlan): Promise<void> {
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
