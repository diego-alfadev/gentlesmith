#!/usr/bin/env bun

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  listLocalProfiles,
  loadProfile,
  migrateRuntimeState,
  resolveFragmentPath,
  resolveRuntimePaths,
  resolveUserPath,
  saveInstalledTarget,
  stripManagedBlock,
  writeRuntimeFile,
  type NamedTarget,
  type ProfileSpec,
  type TargetSpec,
} from "./runtime";
import { runTarget } from "./target";
import {
  applyOpenCodeProfilesPlan,
  planOpenCodeProfiles,
  summarizeOpenCodeProfilesPlan,
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

async function persistPerFragmentPreview(plan: PerFragmentPlan): Promise<void> {
  const lines = [
    `# gentlesmith per-fragment preview: ${plan.targetName}`,
    "",
    `profile: ${plan.profile.name}`,
    `destination: ${plan.destinationDir}`,
    "",
    "## Operations",
    "",
  ];

  if (plan.operations.length === 0) {
    lines.push("No changes.", "");
  } else {
    for (const op of plan.operations) {
      lines.push(`### ${op.kind.toUpperCase()} ${op.path}`, "");
      if (op.kind === "delete") {
        lines.push("Stale Gentlesmith-managed fragment would be deleted.", "");
      } else {
        lines.push("```md", op.content ?? "", "```", "");
      }
    }
  }

  await writeRuntimeFile(join(PATHS.renderedDir, `${plan.targetName}.md`), lines.join("\n"));
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

function destinationCollisionKey(target: TargetSpec): string | null {
  if (target.mode === "opencode-agent") return null;
  const kind = target.mode === "per-fragment" ? "dir" : "file";
  return `${kind}:${resolveUserPath(target.destination)}`;
}

function assertNoTargetDestinationCollisions(targets: NamedTarget[]): void {
  const byDestination = new Map<string, NamedTarget[]>();
  for (const target of targets) {
    const key = destinationCollisionKey(target.spec);
    if (!key) continue;
    byDestination.set(key, [...(byDestination.get(key) ?? []), target]);
  }

  const collisions = Array.from(byDestination.values()).filter((group) => group.length > 1);
  if (collisions.length === 0) return;

  console.error("ERROR: multiple enabled targets write to the same destination.");
  console.error("Disable one target or change its destination before syncing/applying.\n");
  for (const group of collisions) {
    console.error(`destination: ${resolveUserPath(group[0].spec.destination)}`);
    for (const target of group) {
      console.error(`  - ${target.name} (agent=${target.spec.agent}, profile=${target.spec.profile}, mode=${target.spec.mode})`);
    }
    console.error("");
  }
  process.exit(1);
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
  for (const op of creates) console.log(`    + ${basename(op.path)}  (create)`);
  for (const op of updates) console.log(`    ~ ${basename(op.path)}  (update)`);
  for (const op of deletes) console.log(`    - ${basename(op.path)}  (delete — stale)`);
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

async function buildOpenCodeProfileInputs(agentName: string, requiredProfileName?: string) {
  const localProfiles = await listLocalProfiles(PATHS);
  const names = new Set<string>(localProfiles.map((profile) => profile.name));
  if (requiredProfileName) names.add(requiredProfileName);
  if (names.size === 0) names.add("jarvis");

  const out: Array<{ profile: ProfileSpec; prompt: string }> = [];
  for (const name of Array.from(names).sort()) {
    const profile = await loadProfile(PATHS, name);
    out.push({ profile, prompt: await composeFragments(profile, agentName) });
  }
  return out;
}

function runUpdate(): void {
  if (!existsSync(join(PACKAGE_ROOT, ".git"))) {
    console.error("ERROR: gentlesmith was not installed via git clone — cannot self-update.");
    console.error("To update a global beta install: bun add -g gentlesmith@beta");
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

function invokeSkillsBridge(skills: string[], options: { apply: boolean; install: boolean }) {
  const unique = Array.from(new Set(skills.filter((skill) => typeof skill === "string" && skill.trim().length > 0)));
  if (unique.length === 0) return;

  console.log(`\n━━━ skills-bridge (${unique.length} declared) ━━━`);
  if (!options.install) {
    for (const skill of unique) console.log(`  declared: ${skill}`);
    console.log("  no install side effects; use `gentlesmith skills install` to install declared skills");
    return;
  }

  if (!options.apply) {
    for (const skill of unique) console.log(`  would install: ${skill}`);
    console.log("  dry-run; re-run with --apply --install-skills to install declared skills");
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
  const installSkills = args.includes("--install-skills");
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
  assertNoTargetDestinationCollisions(targets);

  for (const { name, spec } of targets) {
    if (spec.mode === "opencode-agent") {
      const profiles = await buildOpenCodeProfileInputs(spec.agent, spec.profile);
      const plan = await planOpenCodeProfiles(spec.destination, profiles);
      summarizeOpenCodeProfilesPlan(plan, apply);
      await writeRuntimeFile(join(PATHS.renderedDir, `${name}.md`), plan.finalContent);
      if (apply) await applyOpenCodeProfilesPlan(plan);
    } else if (spec.mode === "per-fragment") {
      const plan = await planPerFragmentTarget(name, spec, args);
      if (!plan) continue;
      summarizePerFragment(plan, apply);
      await persistPerFragmentPreview(plan);
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

  invokeSkillsBridge(collectedSkills, { apply, install: installSkills });
  console.log(`\nRendered previews saved to: ${PATHS.renderedDir}`);
  if (!apply) console.log("Re-run with `gentlesmith sync --apply` to write changes.");
}

interface ApplyArgs {
  profileName?: string;
  apply: boolean;
  installSkills: boolean;
  targetNames: string[];
}

type ApplyPlan =
  | { kind: "managed"; target: NamedTarget; updatedSpec: TargetSpec; plan: RenderPlan }
  | { kind: "per-fragment"; target: NamedTarget; updatedSpec: TargetSpec; plan: PerFragmentPlan }
  | { kind: "opencode"; target: NamedTarget; updatedSpec: TargetSpec; plan: Awaited<ReturnType<typeof planOpenCodeProfiles>> };

async function persistApplyPreview(item: ApplyPlan): Promise<void> {
  if (item.kind === "managed") {
    await persistRendered(item.plan);
    return;
  }
  if (item.kind === "opencode") {
    await writeRuntimeFile(join(PATHS.renderedDir, `${item.target.name}.md`), item.plan.finalContent);
    return;
  }

  await persistPerFragmentPreview(item.plan);
}

async function runApply(rawArgs: string[]): Promise<void> {
  await ensureRuntimeState(PATHS);
  const args = parseApplyArgs(rawArgs);
  if (!args.profileName) {
    console.error("Usage: gentlesmith apply <profile> [--apply] [--target <name>] [--install-skills]");
    process.exit(1);
  }

  const profileName = await resolveProfileAlias(args.profileName);

  const installed = await listInstalledTargets(PATHS);
  const enabled = installed.filter((target) => target.spec.enabled !== false);
  const targets = resolveApplyTargets(enabled, args);

  if (targets.length === 0) {
    console.log("No switchable targets found.");
    console.log("Use `gentlesmith target list` to inspect installed targets.");
    return;
  }

  const updatedTargets = targets.map((target) => ({
    ...target,
    spec: { ...target.spec, profile: profileName },
  }));
  assertNoTargetDestinationCollisions(updatedTargets);

  console.log(`gentlesmith — PROFILE SWITCH ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`profile: ${profileName}`);

  const plans: ApplyPlan[] = [];
  for (const target of updatedTargets) {
    const previousProfile = targets.find((item) => item.name === target.name)?.spec.profile ?? "(unknown)";
    console.log(`\n━━━ switch target: ${target.name} ━━━`);
    console.log(`  profile: ${previousProfile} → ${profileName}`);

    if (target.spec.mode === "opencode-agent") {
      const profiles = await buildOpenCodeProfileInputs(target.spec.agent, target.spec.profile);
      const plan = await planOpenCodeProfiles(target.spec.destination, profiles, { defaultProfileName: target.spec.profile });
      summarizeOpenCodeProfilesPlan(plan, args.apply);
      console.log("  behavior:     registers Gentlesmith profiles and switches OpenCode default_agent");
      plans.push({ kind: "opencode", target, updatedSpec: target.spec, plan });
    } else if (target.spec.mode === "per-fragment") {
      const plan = await planPerFragmentTarget(target.name, target.spec, rawArgs);
      if (!plan) continue;
      summarizePerFragment(plan, args.apply);
      plans.push({ kind: "per-fragment", target, updatedSpec: target.spec, plan });
    } else {
      const plan = await planTarget(target.name, target.spec, rawArgs);
      if (!plan) continue;
      summarize(plan, args.apply);
      plans.push({ kind: "managed", target, updatedSpec: target.spec, plan });
    }
  }

  const profile = await loadProfile(PATHS, profileName);
  invokeSkillsBridge(profile.skills ?? [], { apply: args.apply, install: args.installSkills });

  if (!args.apply) {
    for (const item of plans) await persistApplyPreview(item);
    console.log(`\nRendered previews saved to: ${PATHS.renderedDir}`);
    console.log("No files changed.");
    console.log(`Re-run with \`gentlesmith apply ${profileName} --apply\` to switch these targets.`);
    return;
  }

  for (const item of plans) {
    await saveInstalledTarget(PATHS, item.target.name, item.updatedSpec);
    if (item.kind === "managed") {
      await persistRendered(item.plan);
      await applyPlan(item.plan);
    } else if (item.kind === "per-fragment") {
      await applyPerFragmentPlan(item.plan);
    } else {
      await writeRuntimeFile(join(PATHS.renderedDir, `${item.target.name}.md`), item.plan.finalContent);
      await applyOpenCodeProfilesPlan(item.plan);
    }
  }

  console.log(`\nApplied profile switch: ${profileName}`);
}

async function resolveProfileAlias(input: string): Promise<string> {
  const candidates = input.startsWith("local-") ? [input] : [input, `local-${input}`];
  for (const candidate of candidates) {
    try {
      await loadProfile(PATHS, candidate);
      return candidate;
    } catch {
    }
  }

  console.error(`Profile not found: ${input}`);
  if (!input.startsWith("local-")) console.error(`Also tried: local-${input}`);
  process.exit(1);
}

function parseApplyArgs(args: string[]): ApplyArgs {
  return {
    profileName: readApplyProfileName(args),
    apply: args.includes("--apply"),
    installSkills: args.includes("--install-skills"),
    targetNames: readRepeatedFlag(args, "--target"),
  };
}

function readApplyProfileName(args: string[]): string | undefined {
  const explicit = readSingleFlag(args, "--profile");
  if (explicit) return explicit;
  return args.find((arg, idx) => {
    if (arg.startsWith("--")) return false;
    const prev = args[idx - 1];
    return prev !== "--target" && prev !== "--profile";
  });
}

function readRepeatedFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return Array.from(new Set(values));
}

function readSingleFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function resolveApplyTargets(enabledTargets: NamedTarget[], args: ApplyArgs): NamedTarget[] {
  if (args.targetNames.length === 0) {
    return enabledTargets;
  }

  const byName = new Map(enabledTargets.map((target) => [target.name, target]));
  const out: NamedTarget[] = [];
  for (const name of args.targetNames) {
    const target = byName.get(name);
    if (!target) {
      console.error(`Target not installed or disabled: ${name}`);
      console.error("Use `gentlesmith target list` to inspect available targets.");
      process.exit(1);
    }
    out.push(target);
  }
  return out;
}

function printUsage(): void {
  console.log(`gentlesmith — forge, review, and switch AI-agent profiles

Recommended flow:
  gentlesmith forge debugger                 create a reviewable profile draft bundle
  gentlesmith export --profile debugger       review/share the profile package
  gentlesmith apply debugger                 preview the profile switch
  gentlesmith apply debugger --apply         write the switch

Primary:
  gentlesmith forge [name]       create a reviewable profile draft bundle
  gentlesmith export             review/share a profile package
  gentlesmith apply <profile>    preview profile switch (writes only with --apply)
  gentlesmith browse             guided cockpit for forge/review/export/apply

Advanced:
  gentlesmith patch              create a profile patch bundle
  gentlesmith sync [--apply]     render current low-level target bindings
  gentlesmith target ...         manage installed target definitions
  gentlesmith skills ...         discover/list/reference/install skills explicitly
  gentlesmith init               deterministic runtime bootstrap
  gentlesmith migrate            import legacy local state
  gentlesmith update             update a git-clone install
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

  if (!command) {
    const { runBrowse } = await import("./browse");
    await runBrowse();
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
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
  if (command === "apply") {
    await runApply(rest);
    return;
  }
  if (command === "patch") {
    const { runPatch } = await import("./patch");
    await runPatch(rest);
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
