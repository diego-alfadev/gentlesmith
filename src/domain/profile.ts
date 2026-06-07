import { readFile } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import { parse as parseYAML } from "yaml";
import type { Exposure, Privacy } from "./artifact";

export interface ProfileArtifactRef {
  ref: string;
  exposure?: Exposure;
  overrides?: Record<string, unknown>;
}

export interface ProfileTargetRef {
  adapter: string;
  mode?: string;
  overrides?: Record<string, unknown>;
}

export type ProfileCapabilityType = "mcp" | "tool" | "command" | "hook" | "memory";

export interface ProfileEnvRef {
  name: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
}

export interface ProfileCapabilityRef {
  id: string;
  type: ProfileCapabilityType;
  description: string;
  privacy?: Privacy;
  env?: ProfileEnvRef[];
  targets?: string[];
  overrides?: Record<string, unknown>;
}

export interface ProfileManifestV1 {
  schemaVersion: 1;
  name: string;
  description?: string;
  artifacts: ProfileArtifactRef[];
  capabilities?: ProfileCapabilityRef[];
  targets?: Record<string, ProfileTargetRef>;
}

const exposures = new Set<Exposure>(["embed", "mention", "none"]);
const capabilityTypes = new Set<ProfileCapabilityType>(["mcp", "tool", "command", "hook", "memory"]);
const privacyValues = new Set<Privacy>(["public", "private", "local"]);

export async function loadProfileManifest(path: string): Promise<ProfileManifestV1> {
  const raw = await readFile(path, "utf8");
  return parseProfileManifest(raw, path);
}

export function parseProfileManifest(raw: string, source = "profile"): ProfileManifestV1 {
  const parsed = parseYAML(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must be a YAML object.`);
  }
  return normalizeProfileManifest(parsed as Record<string, unknown>, source);
}

function normalizeProfileManifest(raw: Record<string, unknown>, source: string): ProfileManifestV1 {
  if (raw.schemaVersion !== 1) throw new Error(`${source}.schemaVersion must be 1.`);
  const name = requireString(raw.name, `${source}.name`);
  const artifacts = normalizeArtifacts(raw.artifacts, source);
  const manifest: ProfileManifestV1 = { schemaVersion: 1, name, artifacts };

  if (raw.description !== undefined) manifest.description = requireString(raw.description, `${source}.description`);
  if (raw.capabilities !== undefined) manifest.capabilities = normalizeCapabilities(raw.capabilities, source);
  if (raw.targets !== undefined) manifest.targets = normalizeTargets(raw.targets, source);

  return manifest;
}

function normalizeArtifacts(value: unknown, source: string): ProfileArtifactRef[] {
  if (!Array.isArray(value)) throw new Error(`${source}.artifacts must be an array.`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${source}.artifacts[${index}] must be an object.`);
    }
    const raw = item as Record<string, unknown>;
    const ref = requirePortableRelativePath(raw.ref, `${source}.artifacts[${index}].ref`);
    const out: ProfileArtifactRef = { ref };

    if (raw.exposure !== undefined) {
      if (typeof raw.exposure !== "string" || !exposures.has(raw.exposure as Exposure)) {
        throw new Error(`${source}.artifacts[${index}].exposure must be embed, mention, or none.`);
      }
      out.exposure = raw.exposure as Exposure;
    }
    if (raw.overrides !== undefined) out.overrides = requireObject(raw.overrides, `${source}.artifacts[${index}].overrides`);
    return out;
  });
}


function normalizeCapabilities(value: unknown, source: string): ProfileCapabilityRef[] {
  if (!Array.isArray(value)) throw new Error(`${source}.capabilities must be an array.`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const raw = requireObject(item, `${source}.capabilities[${index}]`);
    const id = requireString(raw.id, `${source}.capabilities[${index}].id`);
    if (seen.has(id)) throw new Error(`${source}.capabilities contains duplicate id: ${id}`);
    seen.add(id);

    const type = requireCapabilityType(raw.type, `${source}.capabilities[${index}].type`);
    const out: ProfileCapabilityRef = {
      id,
      type,
      description: requireString(raw.description, `${source}.capabilities[${index}].description`),
    };

    if (raw.privacy !== undefined) out.privacy = requirePrivacy(raw.privacy, `${source}.capabilities[${index}].privacy`);
    if (raw.env !== undefined) out.env = normalizeEnvRefs(raw.env, `${source}.capabilities[${index}].env`);
    if (raw.targets !== undefined) out.targets = requireStringArray(raw.targets, `${source}.capabilities[${index}].targets`);
    if (raw.overrides !== undefined) out.overrides = requireObject(raw.overrides, `${source}.capabilities[${index}].overrides`);
    return out;
  });
}

function normalizeEnvRefs(value: unknown, label: string): ProfileEnvRef[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const raw = requireObject(item, `${label}[${index}]`);
    if ("value" in raw) throw new Error(`${label}[${index}].value is not allowed; reference environment variable names only.`);
    const name = requireString(raw.name, `${label}[${index}].name`);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`${label}[${index}].name must be an environment variable name.`);
    if (seen.has(name)) throw new Error(`${label} contains duplicate env name: ${name}`);
    seen.add(name);

    const out: ProfileEnvRef = { name };
    if (raw.required !== undefined) out.required = requireBoolean(raw.required, `${label}[${index}].required`);
    if (raw.secret !== undefined) out.secret = requireBoolean(raw.secret, `${label}[${index}].secret`);
    if (raw.description !== undefined) out.description = requireString(raw.description, `${label}[${index}].description`);
    return out;
  });
}

function normalizeTargets(value: unknown, source: string): Record<string, ProfileTargetRef> {
  const raw = requireObject(value, `${source}.targets`);
  const out: Record<string, ProfileTargetRef> = {};
  for (const [name, target] of Object.entries(raw)) {
    const item = requireObject(target, `${source}.targets.${name}`);
    out[name] = {
      adapter: requireString(item.adapter, `${source}.targets.${name}.adapter`),
    };
    if (item.mode !== undefined) out[name].mode = requireString(item.mode, `${source}.targets.${name}.mode`);
    if (item.overrides !== undefined) out[name].overrides = requireObject(item.overrides, `${source}.targets.${name}.overrides`);
  }
  return out;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function requireCapabilityType(value: unknown, label: string): ProfileCapabilityType {
  if (typeof value !== "string" || !capabilityTypes.has(value as ProfileCapabilityType)) {
    throw new Error(`${label} must be one of: mcp, tool, command, hook, memory.`);
  }
  return value as ProfileCapabilityType;
}

function requirePrivacy(value: unknown, label: string): Privacy {
  if (typeof value !== "string" || !privacyValues.has(value as Privacy)) {
    throw new Error(`${label} must be one of: public, private, local.`);
  }
  return value as Privacy;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}


function requirePortableRelativePath(value: unknown, label: string): string {
  const ref = requireString(value, label);
  if (isAbsolute(ref) || posix.isAbsolute(ref) || win32.isAbsolute(ref) || ref.split(/[\\/]+/).includes("..")) {
    throw new Error(`${label} must be a relative path inside the profile directory.`);
  }
  return ref;
}
