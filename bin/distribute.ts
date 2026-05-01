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
 *   per-fragment   — one .mdc file per fragment (Cursor rules dir)
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

import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
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
  skills?: string[];
}

interface TargetSpec {
  agent: string;
  profile: string;
  destination: string;
  mode: "managed-block" | "prepend" | "per-fragment";
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

function resolvePath(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  if (p.startsWith("./")) return resolve(process.cwd(), p.slice(2));
  return p;
}

function isGentlesmithRepo(dir: string): boolean {
  return (
    existsSync(join(dir, "bin/distribute.ts")) &&
    existsSync(join(dir, "fragments")) &&
    existsSync(join(dir, "profiles"))
  );
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

const KNOWN_FRONTMATTER_KEYS = new Set(["scope", "condition"]);

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const fenceRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = fenceRe.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const body = raw.slice(match[0].length);
  try {
    const parsed = parseYAML(match[1]);
    const meta = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    return { meta, body };
  } catch (err) {
    // Malformed frontmatter — log and fall through to no-scope (include always).
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  WARNING: malformed frontmatter (treated as none): ${msg}`);
    return { meta: {}, body };
  }
}

async function composeFragments(profile: ProfileSpec, agentName: string): Promise<string> {
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
    const raw = await readFile(path, "utf8");
    const { meta, body } = parseFrontmatter(raw);

    // Warn on unrecognized frontmatter keys.
    for (const key of Object.keys(meta)) {
      if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
        console.warn(`  WARNING: fragment ${ref} has unrecognized frontmatter key: "${key}"`);
      }
    }

    // Scope filter: accept string ("agents") or list (["agents", "claude"]).
    // Skip when scope is set and current agent is not included.
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

function stripBlock(content: string): string {
  return content.replace(BLOCK_RE, "").replace(/^\n+/, "").trimEnd();
}

async function planTarget(name: string, target: TargetSpec, args: string[]): Promise<RenderPlan | null> {
  const profile = await loadProfile(target.profile);
  const composed = await composeFragments(profile, target.agent);
  const block = wrapManagedBlock(composed);
  const destinationResolved = resolvePath(target.destination);

  // Self-write guard: prevent polluting gentlesmith's own repo with rendered output.
  const destDir = target.destination.startsWith("./") ? process.cwd() : dirname(destinationResolved);
  if (target.destination.startsWith("./") && isGentlesmithRepo(destDir) && !args.includes("--force")) {
    console.log(`\n━━━ target: ${name} (agent=${target.agent}) ━━━`);
    console.warn(`  SKIPPED — running inside gentlesmith repo (use --force to override)`);
    return null;
  }
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

// ── Per-fragment rendering (Cursor .mdc) ─────────────────────────────────────

const FRAGMENT_MARKER_PREFIX = `<!-- gentle-ai-overlay:${BLOCK_NAME} fragment=`;

interface FileOp {
  kind: "create" | "update" | "delete";
  path: string;
  content?: string;
  fragmentRef?: string;
}

interface PerFragmentPlan {
  targetName: string;
  target: TargetSpec;
  profile: ProfileSpec;
  destinationDir: string;
  operations: FileOp[];
}

function slugify(ref: string): string {
  return ref.replace(/\//g, "-");
}

function projectFrontmatterToMdc(
  meta: Record<string, unknown>,
  body: string,
): Record<string, unknown> {
  const mdc: Record<string, unknown> = {};
  if (typeof meta.description === "string") mdc.description = meta.description;
  else {
    const heading = /^#\s+(.+)/m.exec(body);
    if (heading) mdc.description = heading[1];
  }
  if (meta.globs !== undefined) mdc.globs = meta.globs;
  mdc.alwaysApply = meta.alwaysApply === true;
  return mdc;
}

function composeMdcContent(
  ref: string,
  mdcFrontmatter: Record<string, unknown>,
  body: string,
): string {
  const fmLines = Object.entries(mdcFrontmatter).map(([k, v]) => {
    if (typeof v === "boolean") return `${k}: ${v}`;
    if (Array.isArray(v)) return `${k}: ${JSON.stringify(v)}`;
    return `${k}: "${v}"`;
  });
  const fm = `---\n${fmLines.join("\n")}\n---`;
  const marker = `${FRAGMENT_MARKER_PREFIX}${ref} -->`;
  return `${fm}\n${marker}\n${body.trim()}\n`;
}

async function planPerFragmentTarget(
  name: string,
  target: TargetSpec,
  args: string[],
): Promise<PerFragmentPlan | null> {
  const profile = await loadProfile(target.profile);
  const destinationDir = resolvePath(target.destination);

  // Self-write guard (same logic as block-based targets).
  if (target.destination.startsWith("./") && isGentlesmithRepo(process.cwd()) && !args.includes("--force")) {
    console.log(`\n━━━ target: ${name} (agent=${target.agent}, mode=per-fragment) ━━━`);
    console.warn(`  SKIPPED — running inside gentlesmith repo (use --force to override)`);
    return null;
  }

  const desiredFiles = new Map<string, { content: string; ref: string }>();

  for (const ref of profile.include) {
    const localPath = join(FRAGMENTS_LOCAL_DIR, `${ref}.md`);
    const repoPath = join(FRAGMENTS_DIR, `${ref}.md`);
    const path = existsSync(localPath) ? localPath : repoPath;
    if (!existsSync(path)) {
      throw new Error(`Fragment not found: ${ref} (looked at ${localPath} and ${repoPath})`);
    }
    const raw = await readFile(path, "utf8");
    const { meta, body } = parseFrontmatter(raw);

    // Scope filter.
    if (meta.scope !== undefined && meta.scope !== null) {
      const scopes = Array.isArray(meta.scope) ? meta.scope : [meta.scope];
      if (!scopes.includes(target.agent)) continue;
    }

    const content = body.trim();
    if (content.length === 0) continue;

    if (content.length > 10000) {
      console.warn(`  WARNING: fragment ${ref} exceeds 10000 chars (${content.length}) — Cursor may truncate`);
    }

    const mdcFm = projectFrontmatterToMdc(meta, content);
    const mdcContent = composeMdcContent(ref, mdcFm, content);
    const slug = slugify(ref);
    desiredFiles.set(join(destinationDir, `${slug}.mdc`), { content: mdcContent, ref });
  }

  // Detect stale files: existing .mdc with our marker that are no longer in the desired set.
  const operations: FileOp[] = [];
  for (const [filePath, { content, ref }] of desiredFiles) {
    if (!existsSync(filePath)) {
      operations.push({ kind: "create", path: filePath, content, fragmentRef: ref });
    } else {
      const existing = await readFile(filePath, "utf8");
      if (existing !== content) {
        operations.push({ kind: "update", path: filePath, content, fragmentRef: ref });
      }
    }
  }

  // Stale cleanup: only delete .mdc files that contain our marker.
  if (existsSync(destinationDir)) {
    const existingFiles = (await readdir(destinationDir)).filter((f) => f.endsWith(".mdc"));
    for (const f of existingFiles) {
      const fullPath = join(destinationDir, f);
      if (desiredFiles.has(fullPath)) continue;
      const content = await readFile(fullPath, "utf8");
      if (content.includes(FRAGMENT_MARKER_PREFIX)) {
        operations.push({ kind: "delete", path: fullPath });
      }
    }
  }

  return { targetName: name, target, profile, destinationDir, operations };
}

function summarizePerFragment(plan: PerFragmentPlan, apply: boolean) {
  const verb = apply ? "WRITE" : "WOULD";
  const creates = plan.operations.filter((o) => o.kind === "create");
  const updates = plan.operations.filter((o) => o.kind === "update");
  const deletes = plan.operations.filter((o) => o.kind === "delete");

  console.log(`\n━━━ target: ${plan.targetName} (agent=${plan.target.agent}, mode=per-fragment) ━━━`);
  console.log(`  profile:      ${plan.profile.name}`);
  console.log(`  destination:  ${plan.destinationDir}`);
  console.log(`  fragments:    ${plan.profile.include.length} included`);

  if (plan.operations.length === 0) {
    console.log(`  action:       NO CHANGES`);
    return;
  }

  console.log(`  action:       ${verb} ${creates.length} create / ${updates.length} update / ${deletes.length} delete`);
  for (const op of creates) console.log(`    + ${op.path.split("/").pop()}  (create)`);
  for (const op of updates) console.log(`    ~ ${op.path.split("/").pop()}  (update)`);
  for (const op of deletes) console.log(`    - ${op.path.split("/").pop()}  (delete — stale)`);
}

async function applyPerFragmentPlan(plan: PerFragmentPlan): Promise<void> {
  if (plan.operations.length === 0) return;
  await mkdir(plan.destinationDir, { recursive: true });
  for (const op of plan.operations) {
    if (op.kind === "delete") {
      await unlink(op.path);
    } else {
      await writeFile(op.path, op.content!, "utf8");
    }
  }
}

/**
 * Self-updater — pulls latest from git and reinstalls deps.
 * Only works when running from a git clone (not from a global npm install).
 */
function runUpdate(): void {
  if (!existsSync(join(ROOT, ".git"))) {
    console.error("ERROR: gentlesmith was not installed via git clone — cannot self-update.");
    console.error("To update a global npm install: npm update -g gentlesmith");
    process.exit(1);
  }

  console.log(`gentlesmith — UPDATE (repo: ${ROOT})\n`);

  console.log("→ git pull");
  const pull = spawnSync("git", ["pull"], { cwd: ROOT, stdio: "inherit" });
  if (pull.status !== 0) {
    console.error("ERROR: git pull failed.");
    process.exit(pull.status ?? 1);
  }

  console.log("\n→ bun install");
  const install = spawnSync("bun", ["install"], { cwd: ROOT, stdio: "inherit" });
  if (install.status !== 0) {
    console.error("ERROR: bun install failed.");
    process.exit(install.status ?? 1);
  }

  console.log("\ngentlesmith updated.");
}

/**
 * Skills bridge — Level 3 manifest.
 * Profiles can declare `skills: [pkg, ...]`. On --apply, we delegate install
 * to Vercel's `npx skills` (already mature, 50+ agents). We never replicate
 * its registry; we only forward declared packages.
 */
function invokeSkillsBridge(skills: string[], apply: boolean): void {
  const unique = Array.from(new Set(skills.filter((s) => typeof s === "string" && s.trim().length > 0)));
  if (unique.length === 0) return;

  console.log(`\n━━━ skills-bridge (${unique.length} declared) ━━━`);

  if (!apply) {
    for (const pkg of unique) console.log(`  would install: ${pkg}`);
    console.log("  (dry-run — re-run with --apply to invoke npx skills add)");
    return;
  }

  // Probe for `npx skills` availability with a no-op call.
  const probe = spawnSync("npx", ["--no-install", "skills", "--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.warn("  WARNING: `npx skills` not available — skipping skills-bridge.");
    console.warn("  Install via: npm i -g skills  (https://skills.sh)");
    return;
  }

  for (const pkg of unique) {
    console.log(`  installing: ${pkg}`);
    const result = spawnSync("npx", ["skills", "add", pkg], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn(`  WARNING: failed to install ${pkg} (continuing).`);
    }
  }
}

async function main() {
  // Subcommand dispatch — must be first, before any flag parsing.
  if (process.argv[2] === "init") {
    const { runWizard } = await import("./init.ts");
    await runWizard();
    process.exit(0);
  }
  if (process.argv[2] === "add") {
    const { runAdd } = await import("./add.ts");
    await runAdd(process.argv.slice(3));
    process.exit(0);
  }
  if (process.argv[2] === "browse") {
    const { runBrowse } = await import("./browse.ts");
    await runBrowse();
    process.exit(0);
  }
  if (process.argv[2] === "update") {
    runUpdate();
    process.exit(0);
  }

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

  const collectedSkills: string[] = [];
  const seenProfiles = new Set<string>();

  for (const { name, spec } of targets) {
    if (spec.mode === "per-fragment") {
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

    // Collect skills once per profile (multiple targets may share a profile).
    if (!seenProfiles.has(spec.profile)) {
      seenProfiles.add(spec.profile);
      const profile = await loadProfile(spec.profile);
      if (Array.isArray(profile.skills)) collectedSkills.push(...profile.skills);
    }
  }

  invokeSkillsBridge(collectedSkills, apply);

  console.log(`\nRendered previews saved to: ${RENDERED_DIR}`);
  if (!apply) console.log("Re-run with --apply to write changes.");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
