#!/usr/bin/env bun

import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

export const PACKAGE_ROOT = resolve(import.meta.dir, "..");
export const BLOCK_NAME = "gentlesmith";
export const BLOCK_START = `<!-- gentle-ai-overlay:${BLOCK_NAME} -->`;
export const BLOCK_END = `<!-- /gentle-ai-overlay:${BLOCK_NAME} -->`;
export const BLOCK_RE = new RegExp(
  [
    `<!-- gentle-ai-overlay:${BLOCK_NAME} -->[\\s\\S]*?<!-- /gentle-ai-overlay:${BLOCK_NAME} -->`,
    `<!-- agents-system:start [^>]*-->[\\s\\S]*?<!-- agents-system:end -->`,
  ].join("|"),
  "m",
);
export const FRAGMENT_MARKER_PREFIX = `<!-- gentle-ai-overlay:${BLOCK_NAME} fragment=`;

export interface ProfileSpec {
  name: string;
  description?: string;
  include: string[];
  skills?: string[];
}

export interface TargetSpec {
  agent: string;
  profile: string;
  destination: string;
  mode: "managed-block" | "prepend" | "per-fragment" | "opencode-agent";
  enabled?: boolean;
  sourceTemplate?: string;
}

export interface RuntimePaths {
  packageRoot: string;
  runtimeHome: string;
  builtInFragmentsDir: string;
  builtInProfilesDir: string;
  builtInPresetsDir: string;
  builtInTargetTemplatesDir: string;
  legacyLocalFragmentsDir: string;
  legacyLocalProfilesDir: string;
  legacyLocalPresetsDir: string;
  legacyLocalTargetsDir: string;
  localFragmentsDir: string;
  localProfilesDir: string;
  localPresetsDir: string;
  installedTargetsDir: string;
  stateFile: string;
  renderedDir: string;
}

export interface RuntimeState {
  initialized?: boolean;
  initializedAt?: string;
  migratedFromLegacy?: boolean;
  lastDiscovery?: {
    recommendations?: {
      fragments?: string[];
      targets?: string[];
      skills?: string[];
      warnings?: string[];
    };
  };
}

export interface MigrationReport {
  alreadyMigrated: boolean;
}

export interface NamedTarget {
  name: string;
  spec: TargetSpec;
  path: string;
}

function defaultRuntimeHome(): string {
  return join(homedir(), ".gentlesmith");
}

export function resolveUserPath(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  if (p.startsWith("./")) return resolve(process.cwd(), p.slice(2));
  return p;
}

export function resolveRuntimePaths(): RuntimePaths {
  const runtimeHome = resolveUserPath(process.env.GENTLESMITH_HOME || defaultRuntimeHome());

  return {
    packageRoot: PACKAGE_ROOT,
    runtimeHome,
    builtInFragmentsDir: join(PACKAGE_ROOT, "fragments"),
    builtInProfilesDir: join(PACKAGE_ROOT, "profiles"),
    builtInPresetsDir: join(PACKAGE_ROOT, "presets"),
    builtInTargetTemplatesDir: join(PACKAGE_ROOT, "targets"),
    legacyLocalFragmentsDir: join(PACKAGE_ROOT, "fragments-local"),
    legacyLocalProfilesDir: join(PACKAGE_ROOT, "profiles"),
    legacyLocalPresetsDir: join(PACKAGE_ROOT, "presets"),
    legacyLocalTargetsDir: join(PACKAGE_ROOT, "targets"),
    localFragmentsDir: join(runtimeHome, "fragments-local"),
    localProfilesDir: join(runtimeHome, "profiles"),
    localPresetsDir: join(runtimeHome, "presets"),
    installedTargetsDir: join(runtimeHome, "targets"),
    stateFile: join(runtimeHome, "state.yaml"),
    renderedDir: join(runtimeHome, ".last-rendered"),
  };
}

export async function ensureRuntimeDirs(paths: RuntimePaths): Promise<void> {
  await mkdir(paths.runtimeHome, { recursive: true });
  await mkdir(paths.localFragmentsDir, { recursive: true });
  await mkdir(paths.localProfilesDir, { recursive: true });
  await mkdir(paths.localPresetsDir, { recursive: true });
  await mkdir(paths.installedTargetsDir, { recursive: true });
  await mkdir(paths.renderedDir, { recursive: true });
}

export async function loadYAML<T>(path: string): Promise<T> {
  return parseYAML(await readFile(path, "utf8")) as T;
}

export async function writeYAML(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYAML(value), "utf8");
}

export async function loadRuntimeState(paths: RuntimePaths): Promise<RuntimeState> {
  if (!existsSync(paths.stateFile)) return {};
  return loadYAML<RuntimeState>(paths.stateFile);
}

export async function saveRuntimeState(paths: RuntimePaths, state: RuntimeState): Promise<void> {
  await writeYAML(paths.stateFile, state);
}

export async function markRuntimeInitialized(
  paths: RuntimePaths,
  statePatch: Partial<RuntimeState> = {},
): Promise<RuntimeState> {
  const current = await loadRuntimeState(paths);
  const next: RuntimeState = {
    ...current,
    ...statePatch,
    initialized: true,
    initializedAt: current.initializedAt ?? new Date().toISOString(),
  };
  await saveRuntimeState(paths, next);
  return next;
}

export async function isRuntimeInitialized(paths: RuntimePaths): Promise<boolean> {
  const state = await loadRuntimeState(paths);
  return state.initialized === true;
}

export async function listBuiltInProfiles(paths: RuntimePaths): Promise<Array<{ name: string; path: string }>> {
  const files = (await readdir(paths.builtInProfilesDir)).filter((f) => f.endsWith(".yaml") && !f.startsWith("local-"));
  return files.map((f) => ({ name: f.replace(/\.yaml$/, ""), path: join(paths.builtInProfilesDir, f) }));
}

export async function listLocalProfiles(paths: RuntimePaths): Promise<Array<{ name: string; path: string }>> {
  if (!existsSync(paths.localProfilesDir)) return [];
  const files = (await readdir(paths.localProfilesDir)).filter((f) => f.endsWith(".yaml"));
  return files.map((f) => ({ name: f.replace(/\.yaml$/, ""), path: join(paths.localProfilesDir, f) }));
}

export async function loadProfile(paths: RuntimePaths, name: string): Promise<ProfileSpec> {
  const localPath = join(paths.localProfilesDir, `${name}.yaml`);
  if (existsSync(localPath)) return loadYAML<ProfileSpec>(localPath);
  return loadYAML<ProfileSpec>(join(paths.builtInProfilesDir, `${name}.yaml`));
}

export function resolveFragmentPath(paths: RuntimePaths, ref: string): string {
  const localPath = join(paths.localFragmentsDir, `${ref}.md`);
  if (existsSync(localPath)) return localPath;
  return join(paths.builtInFragmentsDir, `${ref}.md`);
}

export function resolvePresetPath(paths: RuntimePaths, name: string): string | null {
  const localPath = join(paths.localPresetsDir, `${name}.yaml`);
  if (existsSync(localPath)) return localPath;
  const builtInPath = join(paths.builtInPresetsDir, `${name}.yaml`);
  if (existsSync(builtInPath)) return builtInPath;
  return null;
}

export async function listTargetTemplates(paths: RuntimePaths): Promise<NamedTarget[]> {
  const files = (await readdir(paths.builtInTargetTemplatesDir)).filter((f) => f.endsWith(".yaml"));
  const out: NamedTarget[] = [];
  for (const file of files.sort()) {
    const name = file.replace(/\.yaml$/, "");
    const path = join(paths.builtInTargetTemplatesDir, file);
    out.push({ name, spec: await loadYAML<TargetSpec>(path), path });
  }
  return out;
}

export async function listInstalledTargets(paths: RuntimePaths): Promise<NamedTarget[]> {
  if (!existsSync(paths.installedTargetsDir)) return [];
  const files = (await readdir(paths.installedTargetsDir)).filter((f) => f.endsWith(".yaml"));
  const out: NamedTarget[] = [];
  for (const file of files.sort()) {
    const name = file.replace(/\.yaml$/, "");
    const path = join(paths.installedTargetsDir, file);
    out.push({ name, spec: await loadYAML<TargetSpec>(path), path });
  }
  return out;
}

export async function loadInstalledTarget(paths: RuntimePaths, name: string): Promise<NamedTarget | null> {
  const path = join(paths.installedTargetsDir, `${name}.yaml`);
  if (!existsSync(path)) return null;
  return { name, spec: await loadYAML<TargetSpec>(path), path };
}

export async function saveInstalledTarget(paths: RuntimePaths, name: string, spec: TargetSpec): Promise<void> {
  await writeYAML(join(paths.installedTargetsDir, `${name}.yaml`), spec);
}

export async function removeInstalledTarget(paths: RuntimePaths, name: string): Promise<void> {
  const path = join(paths.installedTargetsDir, `${name}.yaml`);
  if (existsSync(path)) {
    await Bun.file(path).delete();
  }
}

export function hasManagedBlock(content: string): boolean {
  return BLOCK_RE.test(content);
}

export function stripManagedBlock(content: string): string {
  const stripped = content.replace(BLOCK_RE, "").replace(/^\n+/, "");
  return stripped.trimEnd();
}

async function readInstalledTargetMarkers(spec: TargetSpec): Promise<boolean> {
  const destination = resolveUserPath(spec.destination);
  if (!existsSync(destination)) return false;

  if (spec.mode === "per-fragment") {
    const entries = (await readdir(destination)).filter((f) => f.endsWith(".mdc"));
    for (const file of entries) {
      const raw = await readFile(join(destination, file), "utf8");
      if (raw.includes(FRAGMENT_MARKER_PREFIX)) return true;
    }
    return false;
  }

  const raw = await readFile(destination, "utf8");
  return hasManagedBlock(raw);
}

export async function detectExistingTargetTemplates(paths: RuntimePaths): Promise<NamedTarget[]> {
  const templates = await listTargetTemplates(paths);
  const detected: NamedTarget[] = [];

  for (const template of templates) {
    if (template.name === "agents-project") continue;
    if (await readInstalledTargetMarkers(template.spec)) {
      detected.push(template);
    }
  }

  return detected;
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  if (!existsSync(sourceDir)) return;
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

async function migrateLegacyLocalProfiles(paths: RuntimePaths): Promise<void> {
  if (!existsSync(paths.legacyLocalProfilesDir)) return;
  const files = (await readdir(paths.legacyLocalProfilesDir)).filter((f) => f.startsWith("local-") && f.endsWith(".yaml"));
  for (const file of files) {
    const source = join(paths.legacyLocalProfilesDir, file);
    const target = join(paths.localProfilesDir, file);
    if (!existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}

async function migrateLegacyLocalPresets(paths: RuntimePaths): Promise<void> {
  if (!existsSync(paths.legacyLocalPresetsDir)) return;
  const files = (await readdir(paths.legacyLocalPresetsDir)).filter((f) => f.startsWith("local-") && f.endsWith(".yaml"));
  for (const file of files) {
    const source = join(paths.legacyLocalPresetsDir, file);
    const target = join(paths.localPresetsDir, file);
    if (!existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}

async function migrateLegacyInstalledTargets(paths: RuntimePaths): Promise<void> {
  const templates = await listTargetTemplates(paths);
  const legacyLocals = existsSync(paths.legacyLocalTargetsDir)
    ? (await readdir(paths.legacyLocalTargetsDir)).filter((f) => f.startsWith("local-") && f.endsWith(".yaml"))
    : [];

  for (const file of legacyLocals) {
    const source = join(paths.legacyLocalTargetsDir, file);
    const name = file.replace(/\.yaml$/, "");
    const target = join(paths.installedTargetsDir, file);
    if (!existsSync(target)) {
      const spec = await loadYAML<TargetSpec>(source);
      await saveInstalledTarget(paths, name, { ...spec, enabled: spec.enabled ?? true, sourceTemplate: spec.sourceTemplate ?? name });
    }
  }

  for (const template of templates) {
    if (template.name === "agents-project") continue;
    const shouldInstall =
      template.spec.profile.startsWith("local-") ||
      await readInstalledTargetMarkers(template.spec);

    if (!shouldInstall) continue;
    if (existsSync(join(paths.installedTargetsDir, `${template.name}.yaml`))) continue;

    await saveInstalledTarget(paths, template.name, {
      ...template.spec,
      enabled: template.spec.enabled ?? true,
      sourceTemplate: template.name,
    });
  }
}

export async function ensureRuntimeState(paths: RuntimePaths): Promise<void> {
  await ensureRuntimeDirs(paths);
}

export async function migrateRuntimeState(paths: RuntimePaths): Promise<MigrationReport> {
  await ensureRuntimeDirs(paths);
  const state = await loadRuntimeState(paths);
  if (state.migratedFromLegacy) return { alreadyMigrated: true };

  await copyDirectoryContents(paths.legacyLocalFragmentsDir, paths.localFragmentsDir);
  await migrateLegacyLocalProfiles(paths);
  await migrateLegacyLocalPresets(paths);
  await migrateLegacyInstalledTargets(paths);

  await saveRuntimeState(paths, { ...state, migratedFromLegacy: true });
  return { alreadyMigrated: false };
}

export async function findNewestLocalProfile(paths: RuntimePaths): Promise<string | null> {
  if (!existsSync(paths.localProfilesDir)) return null;
  const files = (await readdir(paths.localProfilesDir)).filter((f) => f.startsWith("local-") && f.endsWith(".yaml"));
  if (files.length === 0) return null;

  const withMtime = await Promise.all(
    files.map(async (file) => ({
      path: join(paths.localProfilesDir, file),
      mtime: (await stat(join(paths.localProfilesDir, file))).mtimeMs,
    })),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].path;
}

export async function writeRuntimeFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function cloneTemplateTarget(paths: RuntimePaths, templateName: string): Promise<TargetSpec> {
  const templatePath = join(paths.builtInTargetTemplatesDir, `${templateName}.yaml`);
  const spec = await loadYAML<TargetSpec>(templatePath);
  return {
    ...spec,
    enabled: spec.enabled ?? true,
    sourceTemplate: templateName,
  };
}

export async function listInstalledTargetNames(paths: RuntimePaths): Promise<string[]> {
  return (await listInstalledTargets(paths)).map((target) => target.name);
}

export async function removePathIfExists(path: string): Promise<void> {
  if (!existsSync(path)) return;
  await Bun.file(path).delete();
}

export async function copyLegacyFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}
