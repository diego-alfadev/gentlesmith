import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCK_END, BLOCK_START } from "../bin/runtime";

describe("status CLI", () => {
  test("guides empty installs toward scan and neutral import", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-status-empty-"));
    try {
      const home = join(root, "home");
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "bin/distribute.ts", "status"],
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, GENTLESMITH_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain("No installed targets found.");
      expect(out).toContain("gentlesmith scan");
      expect(out).toContain("gentlesmith import jarvis");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shows installed target profile bindings and managed sync state", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-status-"));
    try {
      const home = join(root, "home");
      const destination = join(root, "AGENTS.md");
      await mkdir(join(home, "targets"), { recursive: true });
      await Bun.write(destination, `${BLOCK_START}\n\nManaged by Gentlesmith.\n\n${BLOCK_END}\n`);
      await Bun.write(join(home, "targets", "codex.yaml"), [
        "agent: codex",
        "profile: local-jarvis",
        `destination: ${JSON.stringify(destination)}`,
        "mode: managed-block",
        "enabled: true",
        "",
      ].join("\n"));

      const result = Bun.spawnSync({
        cmd: ["bun", "run", "bin/distribute.ts", "status"],
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, GENTLESMITH_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain("gentlesmith — STATUS");
      expect(out).toContain("codex");
      expect(out).toContain("local-jarvis");
      expect(out).toContain("managed");
      expect(out).not.toContain("Warnings:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
