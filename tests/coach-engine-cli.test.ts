import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("coach engine CLI", () => {
  test("runs an installed engine and returns a proposal without changing the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-coach-engine-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const fakeBin = join(root, "bin");
    const sourcePath = join(home, ".codex", "AGENTS.md");
    const source = "## Rules\n\nAlways verify.\n";

    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await Bun.write(sourcePath, source);
      const fakeOpenCode = join(fakeBin, "opencode");
      await Bun.write(fakeOpenCode, "#!/bin/sh\nprintf 'Read-only cleanup proposal from fake engine.\\n'\n");
      await chmod(fakeOpenCode, 0o755);

      const result = Bun.spawnSync({
        cmd: [
          "bun",
          "run",
          join(import.meta.dir, "..", "bin", "distribute.ts"),
          "coach",
          "cleanup",
          "--engine",
          "opencode",
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
      expect(result.stdout.toString()).toContain("Agent proposal (opencode):");
      expect(result.stdout.toString()).toContain("Read-only cleanup proposal from fake engine.");
      expect(result.stdout.toString()).toContain("Gentlesmith did not apply any changes.");
      expect(await readFile(sourcePath, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
