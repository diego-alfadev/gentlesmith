import type { ProfileCapabilityRef, ProfileCapabilityType, ProfileManifestV1 } from "./profile";

export type CapabilitySupportLevel = "detect-only" | "adapter-managed" | "unsupported" | "not-declared";

export interface CapabilityMatrixCell {
  target: string;
  capability: string;
  type: ProfileCapabilityType;
  level: CapabilitySupportLevel;
  reason: string;
}

const knownTargets = new Set(["claude", "codex", "opencode", "antigravity", "pi", "gentle-ai"]);

export function buildCapabilityMatrix(profile: ProfileManifestV1): CapabilityMatrixCell[] {
  const targetNames = Object.keys(profile.targets ?? {}).sort();
  const capabilities = profile.capabilities ?? [];

  const rows: CapabilityMatrixCell[] = [];
  for (const capability of capabilities) {
    for (const target of targetNames) {
      rows.push(cellFor(capability, target));
    }
  }
  return rows;
}

function cellFor(capability: ProfileCapabilityRef, target: string): CapabilityMatrixCell {
  if (capability.targets && !capability.targets.includes(target)) {
    return {
      target,
      capability: capability.id,
      type: capability.type,
      level: "not-declared",
      reason: "Capability does not declare this target in profile.targets applicability.",
    };
  }

  if (!knownTargets.has(target)) {
    return {
      target,
      capability: capability.id,
      type: capability.type,
      level: "unsupported",
      reason: "No Gentlesmith capability adapter matrix entry exists for this target yet.",
    };
  }

  return {
    target,
    capability: capability.id,
    type: capability.type,
    level: "detect-only",
    reason: "Gentlesmith can model and validate this capability, but does not write target-specific config yet.",
  };
}
