import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const fixtureProfile = join(repoRoot, "tests", "fixtures", "profile-v1", "basic", "gentlesmith.profile.yaml");

describe("Profile v1 export", () => {
  test("exports a reviewable Profile v1 bundle with portability and capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-export-v1-"));
    try {
      const out = join(root, "export");
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "bin/distribute.ts", "export", "--profile", fixtureProfile, "--out", out],
        cwd: repoRoot,
        env: { ...process.env, GENTLESMITH_HOME: join(root, "home") },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Profile v1 export written to:");
      expect(result.stdout.toString()).toContain("Public sharing blocked");

      const catalog = JSON.parse(await readFile(join(out, "catalog.json"), "utf8"));
      expect(catalog.kind).toBe("profile-v1");
      expect(catalog.capabilities.map((capability: { id: string }) => capability.id)).toEqual(["context7", "coolify-api"]);
      expect(catalog.portability.exportable).toBe(false);
      expect(catalog.portability.issues).toContainEqual(expect.objectContaining({
        kind: "capability",
        artifact: "coolify-api",
        privacy: "private",
      }));

      const summary = await readFile(join(out, "summary.md"), "utf8");
      expect(summary).toContain("blocked for public export");
      expect(summary).toContain("coolify-api [tool] privacy=private");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks public Profile v1 export when portability fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "gentlesmith-export-v1-public-"));
    try {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "bin/distribute.ts", "export", "--profile", fixtureProfile, "--out", join(root, "export"), "--public"],
        cwd: repoRoot,
        env: { ...process.env, GENTLESMITH_HOME: join(root, "home") },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("blocked for public sharing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
