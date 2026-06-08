import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { stringify as stringifyYAML } from "yaml";
import type { ArtifactDocument, ArtifactType } from "../domain/artifact";
import type { ProfileManifestV1 } from "../domain/profile";
import { catalogAgentsMarkdown } from "./agents-cataloger";

export interface AssimilateAgentsOptions {
  sourcePath: string;
  outDir: string;
  profileName?: string;
  targetName?: string;
}

export interface AssimilatedArtifact {
  ref: string;
  path: string;
  document: ArtifactDocument;
  content: string;
}

export interface AssimilatedProfileBundle {
  manifest: ProfileManifestV1;
  manifestPath: string;
  manifestContent: string;
  artifacts: AssimilatedArtifact[];
  skipped: Array<{ title: string; disposition: string; reason: string }>;
  warnings: string[];
}

export async function assimilateAgentsMarkdown(
  options: AssimilateAgentsOptions,
): Promise<AssimilatedProfileBundle> {
  const source = await readFile(options.sourcePath, "utf8");
  const catalog = catalogAgentsMarkdown(source);
  if (catalog.artifacts.length === 0) {
    throw new Error(`No AGENTS.md sections found to assimilate: ${options.sourcePath}`);
  }

  const profileName = options.profileName ?? defaultProfileName(options.sourcePath);
  const targetName = options.targetName ?? "codex";
  const artifacts = catalog.artifacts.map((document) => {
    const ref = artifactRef(document.frontmatter.type, document.frontmatter.name);
    return {
      ref,
      path: join(options.outDir, ref),
      document: {
        ...document,
        ref,
      },
      content: renderArtifactDocument({ ...document, ref }),
    } satisfies AssimilatedArtifact;
  });

  const manifest: ProfileManifestV1 = {
    schemaVersion: 1,
    name: profileName,
    description: `Assimilated profile from ${basename(options.sourcePath)}.`,
    artifacts: artifacts.map((artifact) => ({
      ref: artifact.ref,
      exposure: "embed",
    })),
    targets: {
      [targetName]: {
        adapter: "markdown-managed-block",
      },
    },
  };

  return {
    manifest,
    manifestPath: join(options.outDir, "gentlesmith.profile.yaml"),
    manifestContent: stringifyProfileManifest(manifest),
    artifacts,
    skipped: catalog.skipped,
    warnings: catalog.warnings,
  };
}

export async function writeAssimilatedProfileBundle(bundle: AssimilatedProfileBundle): Promise<void> {
  const targets = [bundle.manifestPath, ...bundle.artifacts.map((artifact) => artifact.path)];
  const existing = [];
  for (const target of targets) {
    if (await pathExistsEvenDangling(target)) existing.push(target);
  }
  if (existing.length > 0) {
    throw new Error(`Refusing to overwrite existing profile files: ${existing.join(", ")}`);
  }

  const rootDir = dirname(bundle.manifestPath);
  for (const target of targets) await assertNoSymlinkAncestors(rootDir, target);

  await mkdir(rootDir, { recursive: true });
  for (const artifact of bundle.artifacts) {
    await mkdir(dirname(artifact.path), { recursive: true });
  }

  await writeFileNew(bundle.manifestPath, bundle.manifestContent);
  for (const artifact of bundle.artifacts) {
    await writeFileNew(artifact.path, artifact.content);
  }
}

async function assertNoSymlinkAncestors(rootDir: string, targetPath: string): Promise<void> {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  const rootToTargetDir = relative(root, dirname(target));
  if (rootToTargetDir.startsWith("..") || rootToTargetDir === ".." || posix.isAbsolute(rootToTargetDir)) {
    throw new Error(`Refusing to write outside profile bundle directory: ${targetPath}`);
  }

  const segments = rootToTargetDir ? rootToTargetDir.split(/[\\/]+/).filter(Boolean) : [];
  let current = root;
  await assertExistingDirectoryIsReal(current);
  for (const segment of segments) {
    current = join(current, segment);
    const exists = await pathExistsEvenDangling(current);
    if (!exists) return;
    await assertExistingDirectoryIsReal(current);
  }
}

async function assertExistingDirectoryIsReal(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to write through symlinked profile bundle directory: ${path}`);
    if (!stat.isDirectory()) throw new Error(`Profile bundle path is not a directory: ${path}`);
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") return;
    throw err;
  }
}

async function pathExistsEvenDangling(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }
}

async function writeFileNew(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function stringifyProfileManifest(manifest: ProfileManifestV1): string {
  return stringifyYAML(manifest, { lineWidth: 0 });
}

function renderArtifactDocument(document: ArtifactDocument): string {
  return `---\n${stringifyYAML(document.frontmatter, { lineWidth: 0 }).trim()}\n---\n\n${document.body.trim()}\n`;
}

function artifactRef(type: ArtifactType, name: string): string {
  return posix.join("artifacts", artifactTypeFolder(type), `${name}.md`);
}

function artifactTypeFolder(type: ArtifactType): string {
  switch (type) {
    case "rule":
      return "rules";
    case "workflow":
      return "workflows";
    case "prompt":
      return "prompts";
    case "context":
      return "context";
    case "skill-ref":
      return "skills";
    case "capability-ref":
      return "capabilities";
  }
}

function defaultProfileName(sourcePath: string): string {
  const parentName = slugify(basename(dirname(sourcePath)));
  return parentName ? `${parentName}-profile` : "agents-profile";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
