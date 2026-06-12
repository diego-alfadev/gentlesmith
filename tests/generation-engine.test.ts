import { describe, expect, test } from "bun:test";
import {
  generateAgentProposal,
  type GenerationEngine,
} from "../src/application/generation-engine";
import { runCleanupCoach } from "../src/application/coach-cleanup";
import {
  buildEngineCommand,
  isEngineId,
} from "../src/adapters/cli-generation-engine";

describe("generation engine port", () => {
  test("generates a normalized proposal through the application port", async () => {
    const engine: GenerationEngine = {
      id: "codex",
      label: "Fake Codex",
      available: () => true,
      generate: async (prompt) => `  Proposal for: ${prompt}  `,
    };

    await expect(generateAgentProposal("clean this harness", engine)).resolves.toEqual({
      engine: "codex",
      content: "Proposal for: clean this harness",
    });
  });

  test("refuses unavailable and empty engines", async () => {
    const unavailable: GenerationEngine = {
      id: "claude",
      label: "Fake Claude",
      available: () => false,
      generate: async () => "unused",
    };
    const empty: GenerationEngine = {
      id: "gemini",
      label: "Fake Gemini",
      available: () => true,
      generate: async () => "  ",
    };

    await expect(generateAgentProposal("prompt", unavailable)).rejects.toThrow("not available on PATH");
    await expect(generateAgentProposal("prompt", empty)).rejects.toThrow("returned an empty proposal");
  });

  test("runs the cleanup case through an injected engine without writes", async () => {
    const prompts: string[] = [];
    const engine: GenerationEngine = {
      id: "opencode",
      label: "Fake OpenCode",
      available: () => true,
      generate: async (prompt) => {
        prompts.push(prompt);
        return "Keep Codex as a starter source, then compare Gemini rules.";
      },
    };

    const result = await runCleanupCoach({
      cwd: "/workspace",
      homeDir: "/home/user",
      candidates: [],
      capabilities: [],
      warnings: [],
      nextAction: {
        kind: "browse-manual",
        command: "gentlesmith browse",
        note: "Choose a source manually.",
      },
    }, engine);

    expect(result.proposal).toEqual({
      engine: "opencode",
      content: "Keep Codex as a starter source, then compare Gemini rules.",
    });
    expect(prompts[0]).toContain("Act as a Gentlesmith profile architect.");
    expect(prompts[0]).toContain("Operate in read-only proposal mode.");
  });
});

describe("CLI generation engine adapters", () => {
  test("builds argv without shell interpolation", () => {
    expect(buildEngineCommand("codex", "audit me")).toEqual({
      command: "codex",
      args: ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "audit me"],
    });
    expect(buildEngineCommand("claude", "audit me")).toEqual({
      command: "claude",
      args: ["--permission-mode", "plan", "--no-session-persistence", "--print", "-p", "audit me"],
    });
    expect(buildEngineCommand("gemini", "audit me")).toEqual({
      command: "gemini",
      args: ["--approval-mode", "plan", "-p", "audit me"],
    });
    expect(buildEngineCommand("opencode", "audit me")).toEqual({
      command: "opencode",
      args: ["run", "audit me"],
    });
  });

  test("validates supported engine ids", () => {
    expect(isEngineId("codex")).toBe(true);
    expect(isEngineId("unknown")).toBe(false);
  });
});
