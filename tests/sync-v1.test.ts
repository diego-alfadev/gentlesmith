import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const fixtureProfile = join(repoRoot, "tests", "fixtures", "profile-v1", "basic", "gentlesmith.profile.yaml");

describe("Profile v1 sync", () => {
  test("renders a Profile v1 manifest through a managed-block target", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-sync-v1-"));
    try {
      const home = join(root, "home");
      const destination = join(root, "AGENTS.md");
      await mkdir(join(home, "targets"), { recursive: true });
      await Bun.write(join(home, "targets", "codex.yaml"), [
        "agent: codex",
        `profile: ${JSON.stringify(fixtureProfile)}`,
        `destination: ${JSON.stringify(destination)}`,
        "mode: managed-block",
        "enabled: true",
        "",
      ].join("\n"));

      const result = Bun.spawnSync({
        cmd: ["bun", "run", "bin/distribute.ts", "sync", "--target", "codex", "--apply"],
        cwd: repoRoot,
        env: { ...process.env, GENTLESMITH_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("profile:      jarvis-portable");
      expect(result.stderr.toString()).not.toContain("ERROR");

      const rendered = await readFile(destination, "utf8");
      expect(rendered).toContain("# Gentlesmith Profile: jarvis-portable");
      expect(rendered).toContain("Requires capabilities: coolify-api");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
