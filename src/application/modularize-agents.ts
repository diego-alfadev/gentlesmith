import { assimilateAgentsMarkdown, writeAssimilatedProfileBundle } from "../importers/profile-assimilator";
import type { ArtifactType, Privacy } from "../domain/artifact";

export interface ModularizeAgentsInput {
  sourcePath: string;
  outDir: string;
  profileName?: string;
  targetName?: string;
  dryRun?: boolean;
}

export interface ModularizedArtifactSummary {
  ref: string;
  path: string;
  type: ArtifactType;
  name: string;
  privacy: Privacy;
  exposure: "embed";
}

export interface ModularizeAgentsResult {
  profileName: string;
  sourcePath: string;
  outDir: string;
  manifestPath: string;
  targetName: string;
  wroteFiles: boolean;
  artifacts: ModularizedArtifactSummary[];
  warnings: string[];
  nextCommands: {
    inspect: string;
    render: string;
  };
}

export async function modularizeAgentsProfile(input: ModularizeAgentsInput): Promise<ModularizeAgentsResult> {
  const profileName = normalizeOptionalProfileName(input.profileName);
  const targetName = input.targetName ?? "codex";
  const bundle = await assimilateAgentsMarkdown({
    sourcePath: input.sourcePath,
    outDir: input.outDir,
    profileName,
    targetName,
  });

  if (!input.dryRun) await writeAssimilatedProfileBundle(bundle);

  return {
    profileName: bundle.manifest.name,
    sourcePath: input.sourcePath,
    outDir: input.outDir,
    manifestPath: bundle.manifestPath,
    targetName,
    wroteFiles: !input.dryRun,
    artifacts: bundle.artifacts.map((artifact) => ({
      ref: artifact.ref,
      path: artifact.path,
      type: artifact.document.frontmatter.type,
      name: artifact.document.frontmatter.name,
      privacy: artifact.document.frontmatter.privacy ?? "public",
      exposure: "embed",
    })),
    warnings: bundle.warnings,
    nextCommands: {
      inspect: `gentlesmith v1 inspect --profile ${bundle.manifestPath}`,
      render: `gentlesmith v1 render --profile ${bundle.manifestPath} --target ${targetName}`,
    },
  };
}

function normalizeOptionalProfileName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new Error("profileName must be a non-empty string when provided.");
  return trimmed;
}
