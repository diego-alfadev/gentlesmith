#!/usr/bin/env bun

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYAML } from "yaml";
import {
  BLOCK_RE,
  BLOCK_START,
  BLOCK_END,
  FRAGMENT_MARKER_PREFIX,
  PACKAGE_ROOT,
  ensureRuntimeState,
  listInstalledTargets,
  loadProfile,
  migrateRuntimeState,
  resolveFragmentPath,
  resolveRuntimePaths,
  resolveUserPath,
  stripManagedBlock,
  writeRuntimeFile,
  type ProfileSpec,
  type TargetSpec,
} from "./runtime";
import { runTarget } from "./target";
import {
  applyOpenCodeAgentPlan,
  planOpenCodeProfileAgent,
  summarizeOpenCodeAgentPlan,
} from "./opencode";

const PATHS = resolveRuntimePaths();
const KNOWN_FRONTMATTER_KEYS = new Set(["scope", "condition", "description", "globs", "alwaysApply"]);

type ChangeType = "create" | "replace-block" | "prepend-block" | "append-block" | "noop";

interface RenderPlan {
  targetName: string;
  target: TargetSpec;
  profile: ProfileSpec;
  destinationResolved: string;
  composed: string;
  finalContent: string;
  preExisting: boolean;
  changeType: ChangeType;
  preservedLines: number;
}

interface PerFragmentPlan {
  targetName: string;
  target: TargetSpec;
  profile: ProfileSpec;
  destinationDir: string;
  operations: Array<{ kind: "create" | "update" | "delete"; path: string; content?: string }>;
}

function isGentlesmithRepo(dir: string): boolean {
  return (
    existsSync(join(dir, "bin/distribute.ts")) &&
    existsSync(join(dir, "fragments")) &&
    existsSync(join(dir, "profiles"))
  );
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const fenceRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = fenceRe.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const body = raw.slice(match[0].length);
  try {
    const parsed = parseYAML(match[1]);
    const meta = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    return { meta, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  WARNING: malformed frontmatter (treated as none): ${message}`);
    return { meta: {}, body: raw };
  }
}

async function composeFragments(profile: ProfileSpec, agentName: string): Promise<string> {
  const parts: string[] = [];
  for (const ref of profile.include) {
    if (ref.includes("..")) throw new Error(`Fragment ref must not contain "..": ${ref}`);
    const path = resolveFragmentPath(PATHS, ref);
    if (!existsSync(path)) throw new Error(`Fragment not found: ${ref}`);

    const source = path.startsWith(PATHS.localFragmentsDir) ? "local" : "repo";
    const raw = await readFile(path, "utf8");
    const { meta, body } = parseFrontmatter(raw);

    for (const key of Object.keys(meta)) {
      if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
        console.warn(`  WARNING: fragment ${ref} has unrecognized frontmatter key: "${key}"`);
      }
    }

    if (meta.scope !== undefined && meta.scope !== null) {
      const scopes = Array.isArray(meta.scope) ? meta.scope : [meta.scope];
      if (!scopes.includes(agentName)) continue;
    }

    const content = body.trim();
    if (content.length === 0) continue;
    parts.push(`<!-- fragment: ${ref} (${source}) -->\n${content}`);
  }
  return parts.join("\n\n");
}

function wrapManagedBlock(body: string): string {
  return `${BLOCK_START}\n\n${body}\n\n${BLOCK_END}`;
}

async function loadInstalledTargetsFiltered(filter?: string) {
  const targets = await listInstalledTargets(PATHS);
  return targets
    .filter((target) => target.spec.enabled !== false)
    .filter((target) => !filter || target.name === filter);
}

async function planTarget(name: string, target: TargetSpec, args: string[]): Promise<RenderPlan | null> {
  const profile = await loadProfile(PATHS, target.profile);
  const composed = await composeFragments(profile, target.agent);
  const block = wrapManagedBlock(composed);
  const destinationResolved = resolveUserPath(target.destination);

  const destDir = target.destination.startsWith("./") ? process.cwd() : dirname(destinationResolved);
  if (target.destination.startsWith("./") && isGentlesmithRepo(destDir) && !args.includes("--force")) {
    console.log(`\n━━━ target: ${name} (agent=${target.agent}) ━━━`);
    console.warn("  SKIPPED — running inside gentlesmith repo (use --force to override)");
    return null;
  }

  const preExisting = existsSync(destinationResolved);
  const prepend = target.mode === "prepend";
  let finalContent: string;
  let changeType: ChangeType = "create";
  let preservedLines = 0;

  if (!preExisting) {
    finalContent = `${block}\n`;
  } else {
    const current = await readFile(destinationResolved, "utf8");
    const hasBlock = BLOCK_RE.test(current);

    if (prepend) {
      const rest = hasBlock ? stripManagedBlock(current) : current.trimEnd();
      const candidate = rest.length > 0 ? `${block}\n\n${rest}\n` : `${block}\n`;
      changeType = candidate === current ? "noop" : (hasBlock ? "replace-block" : "prepend-block");
      finalContent = candidate;
      preservedLines = rest.split("\n").length;
    } else {
      if (hasBlock) {
        const replaced = current.replace(BLOCK_RE, block);
        finalContent = replaced;
        changeType = replaced === current ? "noop" : "replace-block";
        preservedLines = current.split("\n").length - block.split("\n").length;
      } else {
        const separator = current.endsWith("\n") ? "" : "\n";
        finalContent = `${current}${separator}\n${block}\n`;
        changeType = "append-block";
        preservedLines = current.split("\n").length;
      }
    }
  }

  return {
    targetName: name,
    target,
    profile,
    destinationResolved,
    composed,
    finalContent,
    preExisting,
    changeType,
    preservedLines,
  };
}

function summarize(plan: RenderPlan, apply: boolean) {
  const lines = plan.finalContent.split("\n").length;
  const blockLines = wrapManagedBlock(plan.composed).split("\n").length;
  const verb = apply ? "WRITE" : "WOULD";
  const actionLabel: Record<ChangeType, string> = {
    create: `${verb} CREATE`,
    "replace-block": `${verb} REPLACE BLOCK`,
    "prepend-block": `${verb} PREPEND BLOCK`,
    "append-block": `${verb} APPEND BLOCK`,
    noop: "NO CHANGES",
  };

  console.log(`\n━━━ target: ${plan.targetName} (agent=${plan.target.agent}) ━━━`);
  console.log(`  profile:      ${plan.profile.name}`);
  console.log(`  mode:         ${plan.target.mode}`);
  console.log(`  fragments:    ${plan.profile.include.length} included`);
  console.log(`  destination:  ${plan.destinationResolved}`);
  console.log(`  pre-existing: ${plan.preExisting ? "yes" : "no"}`);
  console.log(`  action:       ${actionLabel[plan.changeType]}`);
  console.log(`  block lines:  ${blockLines}`);
  console.log(`  total lines:  ${lines}`);
  if (plan.preservedLines > 0) console.log(`  preserved:    ${plan.preservedLines} lines outside block`);
}

function slugify(ref: string): string {
  return ref.replace(/\//g, "-");
}

function projectFrontmatterToMdc(meta: Record<string, unknown>, body: string): Record<string, unknown> {
  const mdc: Record<string, unknown> = {};
  if (typeof meta.description === "string") mdc.description = meta.description;
  else mdc.description = /^#\s+(.+)/m.exec(body)?.[1];
  if (meta.globs !== undefined) mdc.globs = meta.globs;
  mdc.alwaysApply = meta.alwaysApply === true;
  return mdc;
}

function composeMdcContent(ref: string, frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      if (typeof value === "boolean") return `${key}: ${value}`;
      if (Array.isArray(value)) return `${key}: ${JSON.stringify(value)}`;
      return `${key}: "${value}"`;
    });
  const marker = `${FRAGMENT_MARKER_PREFIX}${ref} -->`;
  return `---\n${lines.join("\n")}\n---\n${marker}\n${body.trim()}\n`;
}

async function planPerFragmentTarget(name: string, target: TargetSpec, args: string[]): Promise<PerFragmentPlan | null> {
  const profile = await loadProfile(PATHS, target.profile);
  const destinationDir = resolveUserPath(target.destination);

  if (target.destination.startsWith("./") && isGentlesmithRepo(process.cwd()) && !args.includes("--force")) {
    console.log(`\n━━━ target: ${name} (agent=${target.agent}, mode=per-fragment) ━━━`);
    console.warn("  SKIPPED — running inside gentlesmith repo (use --force to override)");
    return null;
  }

  const desiredFiles = new Map<string, string>();
  for (const ref of profile.include) {
    if (ref.includes("..")) throw new Error(`Fragment ref must not contain "..": ${ref}`);
    const path = resolveFragmentPath(PATHS, ref);
    if (!existsSync(path)) throw new Error(`Fragment not found: ${ref}`);
    const raw = await readFile(path, "utf8");
    const { meta, body } = parseFrontmatter(raw);

    if (meta.scope !== undefined && meta.scope !== null) {
      const scopes = Array.isArray(meta.scope) ? meta.scope : [meta.scope];
      if (!scopes.includes(target.agent)) continue;
    }

    const content = body.trim();
    if (!content) continue;
    desiredFiles.set(join(destinationDir, `${slugify(ref)}.mdc`), composeMdcContent(ref, projectFrontmatterToMdc(meta, content), content));
  }

  const operations: PerFragmentPlan["operations"] = [];
  for (const [filePath, content] of desiredFiles) {
    if (!existsSync(filePath)) operations.push({ kind: "create", path: filePath, content });
    else if (await readFile(filePath, "utf8") !== content) operations.push({ kind: "update", path: filePath, content });
  }

  if (existsSync(destinationDir)) {
    const existingFiles = (await readdir(destinationDir)).filter((file) => file.endsWith(".mdc"));
    for (const file of existingFiles) {
      const fullPath = join(destinationDir, file);
      if (desiredFiles.has(fullPath)) continue;
      const content = await readFile(fullPath, "utf8");
      if (content.includes(FRAGMENT_MARKER_PREFIX)) operations.push({ kind: "delete", path: fullPath });
    }
  }

  return { targetName: name, target, profile, destinationDir, operations };
}

function summarizePerFragment(plan: PerFragmentPlan, apply: boolean) {
  const verb = apply ? "WRITE" : "WOULD";
  const creates = plan.operations.filter((op) => op.kind === "create");
  const updates = plan.operations.filter((op) => op.kind === "update");
  const deletes = plan.operations.filter((op) => op.kind === "delete");

  console.log(`\n━━━ target: ${plan.targetName} (agent=${plan.target.agent}, mode=per-fragment) ━━━`);
  console.log(`  profile:      ${plan.profile.name}`);
  console.log(`  destination:  ${plan.destinationDir}`);
  console.log(`  fragments:    ${plan.profile.include.length} included`);
  if (plan.operations.length === 0) {
    console.log("  action:       NO CHANGES");
    return;
  }

  console.log(`  action:       ${verb} ${creates.length} create / ${updates.length} update / ${deletes.length} delete`);
  for (const op of creates) console.log(`    + ${op.path.split("/").pop()}  (create)`);
  for (const op of updates) console.log(`    ~ ${op.path.split("/").pop()}  (update)`);
  for (const op of deletes) console.log(`    - ${op.path.split("/").pop()}  (delete — stale)`);
}

async function persistRendered(plan: RenderPlan) {
  await writeRuntimeFile(join(PATHS.renderedDir, `${plan.targetName}.md`), plan.finalContent);
}

async function applyPlan(plan: RenderPlan) {
  if (plan.changeType === "noop") return;
  await mkdir(dirname(plan.destinationResolved), { recursive: true });
  await writeFile(plan.destinationResolved, plan.finalContent, "utf8");
}

async function applyPerFragmentPlan(plan: PerFragmentPlan) {
  if (plan.operations.length === 0) return;
  await mkdir(plan.destinationDir, { recursive: true });
  for (const op of plan.operations) {
    if (op.kind === "delete") await unlink(op.path);
    else await writeFile(op.path, op.content!, "utf8");
  }
}

function runUpdate(): void {
  if (!existsSync(join(PACKAGE_ROOT, ".git"))) {
    console.error("ERROR: gentlesmith was not installed via git clone — cannot self-update.");
    console.error("To update a global install: bun add -g gentlesmith");
    process.exit(1);
  }

  console.log(`gentlesmith — UPDATE (repo: ${PACKAGE_ROOT})\n`);
  console.log("→ git pull");
  const pull = spawnSync("git", ["pull"], { cwd: PACKAGE_ROOT, stdio: "inherit" });
  if (pull.status !== 0) process.exit(pull.status ?? 1);

  console.log("\n→ bun install");
  const install = spawnSync("bun", ["install"], { cwd: PACKAGE_ROOT, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status ?? 1);
  console.log("\ngentlesmith updated.");
}

function invokeSkillsBridge(skills: string[], apply: boolean) {
  const unique = Array.from(new Set(skills.filter((skill) => typeof skill === "string" && skill.trim().length > 0)));
  if (unique.length === 0) return;

  console.log(`\n━━━ skills-bridge (${unique.length} declared) ━━━`);
  if (!apply) {
    for (const skill of unique) console.log(`  would install: ${skill}`);
    console.log("  (dry-run — re-run with --apply to invoke npx skills add)");
    return;
  }

  const probe = spawnSync("npx", ["--yes", "skills", "--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.warn("  WARNING: `npx skills` not available — skipping skills-bridge.");
    console.warn("  See https://skills.sh");
    return;
  }

  for (const skill of unique) {
    console.log(`  installing globally: ${skill}`);
    const result = spawnSync("npx", ["--yes", "skills", "add", "-g", skill], { stdio: "inherit" });
    if (result.status !== 0) console.warn(`  WARNING: failed to install ${skill} (continuing).`);
  }
}

async function runSync(rawArgs: string[], legacyCompat = false) {
  await ensureRuntimeState(PATHS);

  const args = [...rawArgs];
  const apply = args.includes("--apply");
  const targetIdx = args.indexOf("--target");
  const filter = targetIdx >= 0 ? args[targetIdx + 1] : undefined;

  if (legacyCompat) {
    console.log("NOTE: `gentlesmith --apply` is deprecated. Prefer `gentlesmith sync --apply`.");
  }

  console.log(`gentlesmith — ${apply ? "APPLY" : "DRY-RUN"}${filter ? ` (target=${filter})` : ""}`);
  const targets = await loadInstalledTargetsFiltered(filter);
  if (targets.length === 0) {
    if (filter) {
      const installed = (await listInstalledTargets(PATHS)).find((target) => target.name === filter);
      if (installed?.spec.enabled === false) {
        console.log(`Target is installed but disabled: ${filter}. Use \`gentlesmith target enable ${filter}\`.`);
        return;
      }
      console.log(`Target not installed: ${filter}. Use \`gentlesmith target add <template>\` or \`gentlesmith target list\`.`);
      return;
    }
    console.log("No installed targets found. Use `gentlesmith init`, `gentlesmith target add <template>`, or `gentlesmith migrate`.");
    return;
  }

  const collectedSkills: string[] = [];
  const seenProfiles = new Set<string>();

  for (const { name, spec } of targets) {
    if (spec.mode === "opencode-agent") {
      const profile = await loadProfile(PATHS, spec.profile);
      const composed = await composeFragments(profile, spec.agent);
      const plan = await planOpenCodeProfileAgent(spec.destination, profile, composed);
      summarizeOpenCodeAgentPlan(plan, apply);
      await writeRuntimeFile(join(PATHS.renderedDir, `${name}.md`), composed);
      if (apply) await applyOpenCodeAgentPlan(plan);
    } else if (spec.mode === "per-fragment") {
      const plan = await planPerFragmentTarget(name, spec, args);
      if (!plan) continue;
      summarizePerFragment(plan, apply);
      if (apply) await applyPerFragmentPlan(plan);
    } else {
      const plan = await planTarget(name, spec, args);
      if (!plan) continue;
      summarize(plan, apply);
      await persistRendered(plan);
      if (apply) await applyPlan(plan);
    }

    if (!seenProfiles.has(spec.profile)) {
      seenProfiles.add(spec.profile);
      const profile = await loadProfile(PATHS, spec.profile);
      if (Array.isArray(profile.skills)) collectedSkills.push(...profile.skills);
    }
  }

  invokeSkillsBridge(collectedSkills, apply);
  console.log(`\nRendered previews saved to: ${PATHS.renderedDir}`);
  if (!apply) console.log("Re-run with `gentlesmith sync --apply` to write changes.");
}

function printUsage(): void {
  console.log(`gentlesmith — compose local AI-agent behavior from fragments

Usage:
  gentlesmith forge              bootstrap if needed, then start LLM-led profile forging
  gentlesmith browse             inspect, edit, and apply profiles from the TUI

Advanced:
  gentlesmith init               deterministic runtime bootstrap
  gentlesmith sync [--apply] [--target <name>]
  gentlesmith export [--profile <profile>] [--out <dir>]
  gentlesmith target <list|add|set-profile|enable|disable|remove|purge> [name]
  gentlesmith skills <list|add|install|find>
  gentlesmith preset list
  gentlesmith preset add <name> [--profile <profile>]
  gentlesmith migrate
  gentlesmith update
`);
}

async function runMigrate(): Promise<void> {
  const before = new Set((await listInstalledTargets(PATHS)).map((target) => target.name));
  const report = await migrateRuntimeState(PATHS);
  const after = await listInstalledTargets(PATHS);
  const added = after.map((target) => target.name).filter((name) => !before.has(name));

  if (report.alreadyMigrated) {
    console.log("Runtime migration already completed.");
    return;
  }

  console.log("Runtime migration completed.");
  if (added.length > 0) {
    console.log("Installed targets detected from existing overlays:");
    for (const name of added) console.log("  " + name);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "init") {
    const { runWizard } = await import("./init");
    await runWizard();
    return;
  }
  if (command === "forge") {
    const { runForge } = await import("./forge");
    await runForge(rest);
    return;
  }
  if (command === "preset") {
    const { runPreset } = await import("./add");
    await runPreset(rest);
    return;
  }
  if (command === "skills") {
    const { runSkills } = await import("./skills");
    await runSkills(rest);
    return;
  }
  if (command === "browse") {
    const { runBrowse } = await import("./browse");
    await runBrowse();
    return;
  }
  if (command === "migrate") {
    await runMigrate();
    return;
  }
  if (command === "update") {
    runUpdate();
    return;
  }
  if (command === "target") {
    await runTarget(rest);
    return;
  }
  if (command === "sync") {
    await runSync(rest);
    return;
  }
  if (command === "export") {
    const { runExport } = await import("./export");
    await runExport(rest);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
