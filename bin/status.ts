#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FRAGMENT_MARKER_PREFIX,
  ensureRuntimeState,
  hasManagedBlock,
  listInstalledTargets,
  resolveRuntimePaths,
  resolveUserPath,
  type NamedTarget,
  type TargetSpec,
} from "./runtime";

const PATHS = resolveRuntimePaths();

type SyncState = "managed" | "missing" | "unmanaged" | "unknown";

interface TargetStatus {
  name: string;
  agent: string;
  profile: string;
  mode: TargetSpec["mode"];
  enabled: boolean;
  destination: string;
  syncState: SyncState;
  warnings: string[];
}

export async function runStatus(_args: string[] = []): Promise<void> {
  await ensureRuntimeState(PATHS);
  const targets = await listInstalledTargets(PATHS);

  console.log("gentlesmith — STATUS");
  console.log(`home: ${PATHS.runtimeHome}`);

  if (targets.length === 0) {
    console.log("\nNo installed targets found.");
    console.log("Run `gentlesmith init` or `gentlesmith forge --from-agents AGENTS.md` to start.");
    return;
  }

  const statuses = await Promise.all(targets.map(readTargetStatus));
  printStatusTable(statuses);
  printWarnings(statuses);
}

async function readTargetStatus(target: NamedTarget): Promise<TargetStatus> {
  const destination = resolveUserPath(target.spec.destination);
  const warnings: string[] = [];
  const enabled = target.spec.enabled !== false;

  if (!enabled) warnings.push("disabled target");

  return {
    name: target.name,
    agent: target.spec.agent,
    profile: target.spec.profile,
    mode: target.spec.mode,
    enabled,
    destination,
    syncState: await detectSyncState(target.spec, destination),
    warnings,
  };
}

async function detectSyncState(spec: TargetSpec, destination: string): Promise<SyncState> {
  if (spec.mode === "opencode-agent") return existsSync(destination) ? "managed" : "missing";
  if (!existsSync(destination)) return "missing";

  if (spec.mode === "per-fragment") {
    const entries = await readdir(destination).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".mdc")) continue;
      const raw = await readFile(join(destination, entry), "utf8").catch(() => "");
      if (raw.includes(FRAGMENT_MARKER_PREFIX)) return "managed";
    }
    return "unmanaged";
  }

  const raw = await readFile(destination, "utf8").catch(() => "");
  return hasManagedBlock(raw) ? "managed" : "unmanaged";
}

function printStatusTable(statuses: TargetStatus[]): void {
  const rows = statuses.map((status) => ({
    target: status.name,
    agent: status.agent,
    profile: status.profile,
    state: status.enabled ? status.syncState : `disabled/${status.syncState}`,
    mode: status.mode,
  }));

  const widths = {
    target: Math.max("target".length, ...rows.map((row) => row.target.length)),
    agent: Math.max("agent".length, ...rows.map((row) => row.agent.length)),
    profile: Math.max("profile".length, ...rows.map((row) => row.profile.length)),
    state: Math.max("state".length, ...rows.map((row) => row.state.length)),
    mode: Math.max("mode".length, ...rows.map((row) => row.mode.length)),
  };

  console.log("");
  console.log([
    pad("target", widths.target),
    pad("agent", widths.agent),
    pad("profile", widths.profile),
    pad("state", widths.state),
    pad("mode", widths.mode),
  ].join("  "));
  console.log([
    "-".repeat(widths.target),
    "-".repeat(widths.agent),
    "-".repeat(widths.profile),
    "-".repeat(widths.state),
    "-".repeat(widths.mode),
  ].join("  "));

  for (const row of rows) {
    console.log([
      pad(row.target, widths.target),
      pad(row.agent, widths.agent),
      pad(row.profile, widths.profile),
      pad(row.state, widths.state),
      pad(row.mode, widths.mode),
    ].join("  "));
  }
}

function printWarnings(statuses: TargetStatus[]): void {
  const warnings = statuses.flatMap((status) => {
    const out = [...status.warnings];
    if (status.syncState === "missing") out.push("destination missing");
    if (status.syncState === "unmanaged") out.push("destination exists but no Gentlesmith marker was found");
    return out.map((warning) => ({ target: status.name, warning }));
  });

  if (warnings.length === 0) return;

  console.log("\nWarnings:");
  for (const item of warnings) console.log(`  - ${item.target}: ${item.warning}`);
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}
