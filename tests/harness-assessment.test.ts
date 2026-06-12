import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarnessAssessmentPrompt,
  runHarnessAssessment,
  writeAssessmentBundle,
  type AssessmentIntent,
} from "../src/application/harness-assessment";
import type { GenerationEngine } from "../src/application/generation-engine";
import type { ScanSetupResult } from "../src/application/scan-setup";

const scan: ScanSetupResult = {
  cwd: "/workspace",
  homeDir: "/home/user",
  candidates: [{
    path: "/home/user/.codex/AGENTS.md",
    kind: "personal-system",
    confidence: "high",
    recommended: true,
    reason: "known global agent instructions location",
    notes: [],
    sections: {
      import: 1,
      exclude: 0,
      review: 0,
      items: [{ title: "Rules", disposition: "import", reason: "durable behavior" }],
    },
  }],
  capabilities: [{
    id: "engram",
    kind: "mcp",
    target: "codex",
    sourcePath: "/home/user/.codex/config.toml",
    status: "detected",
  }],
  nextAction: {
    kind: "import-recommended",
    command: "gentlesmith import jarvis",
    sourcePath: "/home/user/.codex/AGENTS.md",
    note: "Use the safe starter.",
  },
  warnings: [],
};

const intent: AssessmentIntent = {
  believedCurrentState: "I have one Jarvis-like global setup copied across agents.",
  desiredState: "One portable core with target-specific capabilities kept separate.",
  boundaries: ["Do not change existing agent files", "Keep Engram available"],
  includeProfileSuggestions: false,
};

describe("harness assessment", () => {
  test("builds a goal-constrained prompt without unsolicited profiles", () => {
    const prompt = buildHarnessAssessmentPrompt(scan, intent);

    expect(prompt).toContain(intent.believedCurrentState);
    expect(prompt).toContain(intent.desiredState);
    expect(prompt).toContain("Do not propose additional profiles.");
    expect(prompt).toContain("/home/user/.codex/config.toml");
    expect(prompt).not.toContain("## Optional profile suggestions");
  });

  test("allows profile suggestions only when explicitly requested", () => {
    const prompt = buildHarnessAssessmentPrompt(scan, {
      ...intent,
      includeProfileSuggestions: true,
    });

    expect(prompt).toContain("Profile suggestions requested: yes");
    expect(prompt).toContain("## Optional profile suggestions");
  });

  test("writes the entire review into a new isolated bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-assessment-"));
    const outDir = join(root, "review");
    const engine: GenerationEngine = {
      id: "codex",
      label: "Fake Codex",
      available: () => true,
      generate: async () => "## Executive assessment\n\nKeep the source intact.",
    };

    try {
      const result = await runHarnessAssessment(scan, intent, engine, { model: "test-model" });
      const bundle = await writeAssessmentBundle(outDir, result);

      expect(await readFile(bundle.files.proposal, "utf8")).toContain("Keep the source intact.");
      expect(JSON.parse(await readFile(bundle.files.context, "utf8")).intent).toEqual(intent);
      expect(JSON.parse(await readFile(bundle.files.run, "utf8"))).toMatchObject({
        engine: "codex",
        appliedChanges: false,
        metrics: { model: "test-model" },
      });
      await expect(writeAssessmentBundle(outDir, result)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
