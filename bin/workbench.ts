#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProfileSpec, RuntimePaths } from "./runtime";

export type WorkbenchIntent = "create-profile" | "improve-profile" | "patch-profile" | "reference-skill";
export type WorkbenchLevel = "install-only" | "reference" | "adapted" | "embedded";
export type WorkbenchSourceType = "idea" | "skill" | "file" | "fragment";

export interface WorkbenchProfile {
  name: string;
  path: string;
  isLocal: boolean;
  spec: ProfileSpec;
}

export interface WorkbenchSourceMaterial {
  type: WorkbenchSourceType;
  name: string;
  originalPath?: string;
  bundleFile: string;
  content: string;
}

export interface ProfileWorkbenchBundleContext {
  generatedAt: string;
  intent: WorkbenchIntent;
  targetProfileName: string;
  profile: WorkbenchProfile;
  source: Omit<WorkbenchSourceMaterial, "content">;
  sources: Array<Omit<WorkbenchSourceMaterial, "content">>;
  level: WorkbenchLevel;
  runtime: {
    home: string;
    localFragmentsDir: string;
    localProfilesDir: string;
    bundleDir: string;
  };
  allowedWrites: string[];
  verifyCommands: string[];
  discovery: string[];
}

export interface BuildWorkbenchContextInput {
  paths: RuntimePaths;
  outDir: string;
  intent: WorkbenchIntent;
  profile: WorkbenchProfile;
  sources: WorkbenchSourceMaterial[];
  level: WorkbenchLevel;
  discovery: string[];
  targetProfileName?: string;
}

export interface WriteWorkbenchBundleInput {
  outDir: string;
  context: ProfileWorkbenchBundleContext;
  sources: WorkbenchSourceMaterial[];
  handoff: string;
  readme: string;
}

export function buildProfileWorkbenchContext(input: BuildWorkbenchContextInput): ProfileWorkbenchBundleContext {
  const primarySource = input.sources[0];
  if (!primarySource) throw new Error("Workbench bundle requires at least one source material.");

  const reviewProfile = input.targetProfileName ?? recommendedReviewProfile(input.profile);
  return {
    generatedAt: new Date().toISOString(),
    intent: input.intent,
    targetProfileName: reviewProfile,
    profile: input.profile,
    source: stripSourceContent(primarySource),
    sources: input.sources.map(stripSourceContent),
    level: input.level,
    runtime: {
      home: input.paths.runtimeHome,
      localFragmentsDir: input.paths.localFragmentsDir,
      localProfilesDir: input.paths.localProfilesDir,
      bundleDir: input.outDir,
    },
    allowedWrites: defaultAllowedWrites(input.paths),
    verifyCommands: [
      `gentlesmith export --profile ${reviewProfile}`,
      `gentlesmith apply ${reviewProfile.replace(/^local-/, "")}`,
      `gentlesmith apply ${reviewProfile.replace(/^local-/, "")} --apply`,
    ],
    discovery: input.discovery,
  };
}

export async function writeProfileWorkbenchBundle(input: WriteWorkbenchBundleInput): Promise<void> {
  await mkdir(input.outDir, { recursive: true });
  for (const source of input.sources) {
    const outPath = join(input.outDir, source.bundleFile);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, source.content, "utf8");
  }
  await writeFile(join(input.outDir, "context.json"), JSON.stringify(input.context, null, 2) + "\n", "utf8");
  await writeFile(join(input.outDir, "handoff.md"), input.handoff, "utf8");
  await writeFile(join(input.outDir, "README.md"), input.readme, "utf8");
}

export function buildPatchHandoff(context: ProfileWorkbenchBundleContext): string {
  const profileWriteGuidance = context.profile.isLocal
    ? `Update this local profile if needed: \`${context.profile.path}\`.`
    : [
      `The selected profile is built-in: \`${context.profile.path}\`.`,
      "Do not edit package built-ins. If a profile change is needed, create a runtime-local profile under `~/.gentlesmith/profiles/` derived from it.",
      `Recommended derived profile name: \`${recommendedReviewProfile(context.profile)}\`.`,
    ].join("\n");

  return `# gentlesmith patch handoff

You are helping apply a Gentlesmith profile patch.

Gentlesmith composes markdown fragments into AI-agent configuration overlays. Built-ins live in the installed package; user state lives in \`~/.gentlesmith\`. Your job is to propose/write runtime-local changes only.

## Intent

\`${context.intent}\`

## Selected profile

- name: \`${context.profile.name}\`
- local: ${context.profile.isLocal ? "yes" : "no"}
- path: \`${context.profile.path}\`

${profileWriteGuidance}

Current profile spec:

\`\`\`json
${JSON.stringify(context.profile.spec, null, 2)}
\`\`\`

## Source

- type: \`${context.source.type}\`
- name: \`${context.source.name}\`
- bundled file: \`${context.source.bundleFile}\`
${context.source.originalPath ? `- original path: \`${context.source.originalPath}\`` : ""}

Read bundled source material before writing:

${context.sources.map((source) => `- \`${join(context.runtime.bundleDir, source.bundleFile)}\``).join("\n")}

## Incorporation level requested

\`${context.level}\`

Use this matrix before writing:

| Level | Meaning | Expected output |
|---|---|---|
| install-only | Skill/source remains available for manual invocation. | Usually no profile write; maybe add a note. |
| reference | Profile knows when to suggest/use it. | Compact \`references/<slug>.md\` fragment plus profile include; do not copy full source. |
| adapted | Extract durable behavior. | Concise \`persona/<slug>\`, \`rules/<slug>\`, or \`workflows/<slug>\` fragment plus profile include. |
| embedded | Make it part of core persona/rules. | Edit/create persona/rule carefully; highest blast radius. |

Before writing, briefly state whether the requested level is appropriate. If a lower-intrusion level is better, recommend it.

## Allowed writes

Only write runtime-local Gentlesmith files:

${context.allowedWrites.map((path) => `- \`${path}\``).join("\n")}

Do not edit target agent files directly. Do not edit package built-ins. Do not write secrets.

## Style constraints

- Keep fragments compact and high-signal.
- Prefer examples over abstract teaching.
- Do not paste a full skill into a persona unless the user explicitly chooses embedded behavior and accepts the cost.
- For L1 reference, prefer \`references/<slug>\`.
- For L2 adapted behavior, prefer \`persona/<slug>\`, \`rules/<slug>\`, or \`workflows/<slug>\`.

## Verification

After writing runtime-local changes, run or ask the user to run:

\`\`\`bash
${context.verifyCommands[0]}
${context.verifyCommands[1]}
# only after review:
${context.verifyCommands[2]}
\`\`\`
`;
}

export function buildForgeHandoff(context: ProfileWorkbenchBundleContext): string {
  const profileAction = context.profile.isLocal
    ? `You may update the selected local profile if that matches the user's request: \`${context.profile.path}\`.`
    : [
      `The base profile is built-in: \`${context.profile.path}\`.`,
      "Do not edit package built-ins.",
      `Create or update this runtime-local profile instead: \`~/.gentlesmith/profiles/${context.targetProfileName}.yaml\`.`,
    ].join("\n");

  return `# gentlesmith forge handoff

You are helping forge a Gentlesmith profile.

Gentlesmith composes markdown fragments into AI-agent configuration overlays. Built-ins live in the installed package; user state lives in \`~/.gentlesmith\`. Your job is to propose/write runtime-local profile and fragment changes only.

## Intent

\`${context.intent}\`

## Target profile

- target profile: \`${context.targetProfileName}\`
- base/current profile: \`${context.profile.name}\`
- base/current path: \`${context.profile.path}\`
- base/current is local: ${context.profile.isLocal ? "yes" : "no"}

${profileAction}

Base/current profile spec:

\`\`\`json
${JSON.stringify(context.profile.spec, null, 2)}
\`\`\`

## Detected runtime

${context.discovery.map((line) => `- ${line}`).join("\n")}

## Source material

Read bundled source material before writing:

${context.sources.map((source) => `- \`${join(context.runtime.bundleDir, source.bundleFile)}\``).join("\n")}

If the bundle includes \`sources/env-baseline.md\`, treat it as reusable context from an existing local profile and preserve useful \`env/*\` includes when creating a variant. If it includes \`sources/env-policy.md\`, follow that policy and keep the profile env-agnostic unless the user explicitly changes direction.

If the bundle includes \`sources/skills-discovery.md\`, use it to recommend whether skills belong at L0/L1/L2/L3. Do not copy long third-party skill bodies into profile fragments by default.

If the bundle includes \`sources/gentle-ai-bridge.md\`, treat it as bridge-readiness context only. Do not assume a direct gentle-ai transport exists unless the file says the contract has been verified.

## What to produce

Create or refine \`${context.targetProfileName}\` as a local Gentlesmith profile.

Expected writes:

- \`~/.gentlesmith/profiles/${context.targetProfileName}.yaml\`
- \`~/.gentlesmith/fragments-local/persona/<slug>.md\` if persona changes are needed
- \`~/.gentlesmith/fragments-local/rules/<slug>.md\` if workflow/rule changes are needed
- \`~/.gentlesmith/fragments-local/env/<name>.md\` only when concrete env facts are discovered
- \`~/.gentlesmith/fragments-local/references/<slug>.md\` for L1 skill/reference guidance when appropriate

Preserve useful env/toolchain fragments from existing local profiles when creating variants unless the requested profile should be env-agnostic.

## Allowed writes

Only write runtime-local Gentlesmith files:

${context.allowedWrites.map((path) => `- \`${path}\``).join("\n")}

Do not edit target agent files directly. Do not edit package built-ins. Do not write secrets.

## Style constraints

- Keep the profile compact and aligned with the requested profile kind.
- Default to low-intrusion behavior; do not force Jarvis/developer conventions into domain, blank, or subagent profiles.
- Prefer references or small adapted fragments over copying long skill bodies.
- Treat \`skills:\` as simple metadata/package list for now; do not introduce structured skill objects.
- Ask at most two focused questions before proposing writes.

## Verification

After writing runtime-local changes, run or ask the user to run:

\`\`\`bash
${context.verifyCommands[0]}
${context.verifyCommands[1]}
# only after review:
${context.verifyCommands[2]}
\`\`\`
`;
}

export function buildWorkbenchReadme(context: ProfileWorkbenchBundleContext): string {
  return `# Gentlesmith workbench bundle

- generated: ${context.generatedAt}
- intent: ${context.intent}
- profile: ${context.profile.name}
- target profile: ${context.targetProfileName}
- source: ${context.source.type} / ${context.source.name}
- level: ${context.level}

Give \`handoff.md\` to an AI coding agent. The agent should read \`context.json\` and the files under \`sources/\`, then write only runtime-local Gentlesmith changes.

Review with:

\`\`\`bash
${context.verifyCommands[0]}
gentlesmith sync
\`\`\`

Apply only after review:

\`\`\`bash
gentlesmith apply <profile> --apply
\`\`\`
`;
}

export function recommendedReviewProfile(profile: { name: string; isLocal: boolean }): string {
  return profile.isLocal ? profile.name : `local-${slugify(profile.name)}`;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "patch";
}

function defaultAllowedWrites(paths: RuntimePaths): string[] {
  return [
    join(paths.localFragmentsDir, "persona", "*.md"),
    join(paths.localFragmentsDir, "rules", "*.md"),
    join(paths.localFragmentsDir, "workflows", "*.md"),
    join(paths.localFragmentsDir, "env", "*.md"),
    join(paths.localFragmentsDir, "references", "*.md"),
    join(paths.localProfilesDir, "*.yaml"),
  ];
}

function stripSourceContent(source: WorkbenchSourceMaterial): Omit<WorkbenchSourceMaterial, "content"> {
  return {
    type: source.type,
    name: source.name,
    originalPath: source.originalPath,
    bundleFile: source.bundleFile,
  };
}
