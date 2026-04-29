#!/usr/bin/env bun
/**
 * gentlesmith — forge a custom AI agent
 *
 * Compose fragments → profiles → render into agent system-prompt files via
 * a managed marker block. Dry-run by default. Pass --apply to write.
 *
 * Modes (set in targets/*.yaml):
 *   managed-block  — appends block at end of existing file
 *   prepend        — puts block at top; gentle-ai content (if any) stays below
 *
 * Marker namespace:
 *   <!-- gentle-ai-overlay:gentlesmith -->
 *     ...rendered profile content...
 *   <!-- /gentle-ai-overlay:gentlesmith -->
 *
 * Coexistence: gentle-ai's own markers (<!-- gentle-ai:* -->) and ours
 * (<!-- gentle-ai-overlay:gentlesmith -->) live in the same file without
 * collision. gentle-ai's sync preserves anything outside its namespace.
 *
 * Usage:
 *   bun run distribute                    # dry-run, all targets
 *   bun run distribute --target claude    # dry-run, only claude
 *   bun run distribute --apply            # apply all
 *   bun run distribute --apply --target claude
 *
 *   # Or via npx (after publish):
 *   npx gentlesmith --apply
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { parse as parseYAML } from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const FRAGMENTS_DIR = join(ROOT, "fragments");
const FRAGMENTS_LOCAL_DIR = join(ROOT, "fragments-local");  // gitignored personal overrides
const PROFILES_DIR = join(ROOT, "profiles");
const TARGETS_DIR = join(ROOT, "targets");
const RENDERED_DIR = join(ROOT, ".last-rendered");

const BLOCK_NAME = "gentlesmith";
const BLOCK_START = `<!-- gentle-ai-overlay:${BLOCK_NAME} -->`;
const BLOCK_END = `<!-- /gentle-ai-overlay:${BLOCK_NAME} -->`;

// BLOCK_RE matches the current marker AND legacy markers from earlier versions
// of this tool, so a single --apply migrates files seamlessly. If multiple
// blocks somehow exist, only the first is consumed; rerun --apply to clean up.
const BLOCK_RE = new RegExp(
  [
    // Current: <!-- gentle-ai-overlay:gentlesmith --> ... <!-- /gentle-ai-overlay:gentlesmith -->
    `<!-- gentle-ai-overlay:${BLOCK_NAME} -->[\\s\\S]*?<!-- /gentle-ai-overlay:${BLOCK_NAME} -->`,
    // Legacy v0 (agents-system pre-rebrand): <!-- agents-system:start vX --> ... <!-- agents-system:end -->
    `<!-- agents-system:start [^>]*-->[\\s\\S]*?<!-- agents-system:end -->`,
  ].join("|"),
  "m",
);

interface ProfileSpec {
  name: string;
  description?: string;
  include: string[];
}

interface TargetSpec {
  agent: string;
  profile: string;
  destination: string;
  mode: "managed-block" | "prepend";
}

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

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

async function loadYAML<T>(path: string): Promise<T> {
  return parseYAML(await readFile(path, "utf8")) as T;
}

async function loadAllTargets(filter?: string): Promise<Array<{ name: string; spec: TargetSpec }>> {
  const files = (await readdir(TARGETS_DIR)).filter((f) => f.endsWith(".yaml"));
  const out: Array<{ name: string; spec: TargetSpec }> = [];
  for (const f of files) {
    const name = f.replace(/\.yaml$/, "");
    if (filter && name !== filter) continue;
    out.push({ name, spec: await loadYAML<TargetSpec>(join(TARGETS_DIR, f)) });
  }
  return out;
}

async function loadProfile(name: string): Promise<ProfileSpec> {
  return loadYAML<ProfileSpec>(join(PROFILES_DIR, `${name}.yaml`));
}

async function composeFragments(profile: ProfileSpec): Promise<string> {
  const parts: string[] = [];
  for (const ref of profile.include) {
    // Resolution order: fragments-local/ wins over fragments/.
    // Lets users keep personal overrides outside the public repo (gitignored).
    const localPath = join(FRAGMENTS_LOCAL_DIR, `${ref}.md`);
    const repoPath = join(FRAGMENTS_DIR, `${ref}.md`);
    const path = existsSync(localPath) ? localPath : repoPath;
    if (!existsSync(path)) {
      throw new Error(`Fragment not found: ${ref} (looked at ${localPath} and ${repoPath})`);
    }
    const source = path === localPath ? "local" : "repo";
    const content = (await readFile(path, "utf8")).trim();
    if (content.length === 0) continue;
    parts.push(`<!-- fragment: ${ref} (${source}) -->\n${content}`);
  }
  return parts.join("\n\n");
}

function wrapManagedBlock(body: string): string {
  return `${BLOCK_START}\n\n${body}\n\n${BLOCK_END}`;
}

function stripBlock(content: string): string {
  return content.replace(BLOCK_RE, "").replace(/^\n+/, "").trimEnd();
}

async function planTarget(name: string, target: TargetSpec): Promise<RenderPlan> {
  const profile = await loadProfile(target.profile);
  const composed = await composeFragments(profile);
  const block = wrapManagedBlock(composed);
  const destinationResolved = expandHome(target.destination);
  const preExisting = existsSync(destinationResolved);
  const prepend = target.mode === "prepend";

  let finalContent: string;
  let changeType: ChangeType = "create";
  let preservedLines = 0;

  if (!preExisting) {
    finalContent = block + "\n";
  } else {
    const current = await readFile(destinationResolved, "utf8");
    const hasBlock = BLOCK_RE.test(current);

    if (prepend) {
      // Always keep block at top. Strip existing block (wherever it is), prepend fresh.
      const rest = hasBlock ? stripBlock(current) : current.trimEnd();
      const candidate = rest.length > 0
        ? `${block}\n\n${rest}\n`
        : `${block}\n`;
      changeType = candidate === current ? "noop" : (hasBlock ? "replace-block" : "prepend-block");
      finalContent = candidate;
      preservedLines = rest.split("\n").length;
    } else {
      // managed-block: append or in-place replace
      if (hasBlock) {
        const replaced = current.replace(BLOCK_RE, block);
        finalContent = replaced;
        changeType = replaced === current ? "noop" : "replace-block";
        preservedLines = current.split("\n").length - block.split("\n").length;
      } else {
        const sep = current.endsWith("\n") ? "" : "\n";
        finalContent = `${current}${sep}\n${block}\n`;
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
    create:          `${verb} CREATE`,
    "replace-block": `${verb} REPLACE BLOCK`,
    "prepend-block": `${verb} PREPEND BLOCK`,
    "append-block":  `${verb} APPEND BLOCK`,
    noop:            "NO CHANGES",
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
  if (plan.preservedLines > 0) {
    console.log(`  preserved:    ${plan.preservedLines} lines outside block`);
  }
}

async function persistRendered(plan: RenderPlan) {
  if (!existsSync(RENDERED_DIR)) {
    await mkdir(RENDERED_DIR, { recursive: true });
  }
  const out = join(RENDERED_DIR, `${plan.targetName}.md`);
  await writeFile(out, plan.finalContent, "utf8");
}

async function applyPlan(plan: RenderPlan) {
  if (plan.changeType === "noop") return;
  const dir = dirname(plan.destinationResolved);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(plan.destinationResolved, plan.finalContent, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const targetIdx = args.indexOf("--target");
  const filter = targetIdx >= 0 ? args[targetIdx + 1] : undefined;

  console.log(`gentlesmith — ${apply ? "APPLY" : "DRY-RUN"}${filter ? ` (target=${filter})` : ""}`);

  const targets = await loadAllTargets(filter);
  if (targets.length === 0) {
    console.log("No targets found.");
    return;
  }

  for (const { name, spec } of targets) {
    const plan = await planTarget(name, spec);
    summarize(plan, apply);
    await persistRendered(plan);
    if (apply) await applyPlan(plan);
  }

  console.log(`\nRendered previews saved to: ${RENDERED_DIR}`);
  if (!apply) console.log("Re-run with --apply to write changes.");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
