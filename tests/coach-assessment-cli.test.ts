import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("coach assessment CLI", () => {
  test("writes an isolated assessment bundle from explicit interview answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-assess-cli-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const fakeBin = join(root, "bin");
    const outDir = join(root, "assessment");
    const sourcePath = join(home, ".codex", "AGENTS.md");
    const source = "## Rules\n\nAlways verify.\n";

    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await Bun.write(sourcePath, source);
      const fakeOpenCode = join(fakeBin, "opencode");
      await Bun.write(fakeOpenCode, "#!/bin/sh\nprintf '## Executive assessment\\n\\nKeep the portable core small.\\n'\n");
      await chmod(fakeOpenCode, 0o755);

      const result = Bun.spawnSync({
        cmd: [
          "bun",
          "run",
          join(import.meta.dir, "..", "bin", "distribute.ts"),
          "coach",
          "assess",
          "--engine",
          "opencode",
          "--current",
          "One copied global setup",
          "--goal",
          "One portable modular core",
          "--boundary",
          "Do not modify live files",
          "--no-profiles",
          "--out",
          outDir,
        ],
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          GENTLESMITH_HOME: join(home, ".gentlesmith"),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Assessment proposal completed");
      expect(await readFile(join(outDir, "agent-proposal.md"), "utf8")).toContain("Keep the portable core small.");
      expect(await readFile(sourcePath, "utf8")).toBe(source);
      const context = JSON.parse(await readFile(join(outDir, "assessment-context.json"), "utf8"));
      expect(context.intent).toMatchObject({
        desiredState: "One portable modular core",
        includeProfileSuggestions: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
