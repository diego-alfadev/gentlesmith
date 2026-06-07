import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArtifactMarkdown,
  type ArtifactFrontmatter,
} from "../src/domain/artifact";
import { loadProfileManifest, parseProfileManifest } from "../src/domain/profile";
import { buildResourceGraph } from "../src/domain/resource-graph";
import { buildCapabilityMatrix } from "../src/domain/capability-matrix";
import { checkPublicExportPortability } from "../src/domain/validation";
import { renderManagedMarkdown } from "../src/adapters/markdown-managed-block";
import { catalogAgentsMarkdown } from "../src/importers/agents-cataloger";
import { readTextFixture } from "../src/testing/golden";
import { runProfileV1Command } from "../bin/profile-v1";
import { runForge } from "../bin/forge";
import { modularizeAgentsProfile } from "../src/application/modularize-agents";

const fixtures = join(import.meta.dir, "fixtures", "profile-v1");

describe("profile v1 manifest and artifacts", () => {
  test("loads a neutral manifest without rendering target output", async () => {
    const profile = await loadProfileManifest(join(fixtures, "basic", "gentlesmith.profile.yaml"));

    expect(profile.schemaVersion).toBe(1);
    expect(profile.name).toBe("jarvis-portable");
    expect(profile.artifacts).toHaveLength(4);
    expect(profile.capabilities?.map((capability) => capability.id)).toEqual(["context7", "coolify-api"]);
    expect(profile.capabilities?.[1].env?.[0]).toMatchObject({ name: "COOLIFY_TOKEN", secret: true, required: true });
    expect(profile.capabilities?.[1].localPaths?.[0]).toMatchObject({ path: "~/.config/coolify/config.json", required: false });
    expect(profile.artifacts[0]).toEqual({
      ref: "artifacts/rules/safety.md",
      exposure: "embed",
      overrides: {
        "markdown-managed-block": {
          title: "Operating Safety",
        },
      },
    });
  });

  test("parses minimal neutral frontmatter and preserves body content", async () => {
    const raw = await readTextFixture(join(fixtures, "basic", "artifacts", "rules", "safety.md"));
    const artifact = parseArtifactMarkdown(raw, "artifacts/rules/safety.md");

    expect(artifact.frontmatter).toEqual({
      name: "safety",
      type: "rule",
      description: "Safety and reversible-action rules.",
      tags: ["safety", "workflow"],
      privacy: "public",
    } satisfies ArtifactFrontmatter);
    expect(artifact.body).toContain("Ask before destructive actions.");
  });

  test("rejects workflow artifacts that are not procedural Markdown", async () => {
    const raw = await readTextFixture(join(fixtures, "non-procedural-workflow.md"));

    expect(() => parseArtifactMarkdown(raw, "non-procedural-workflow.md"))
      .toThrow("Workflow artifact non-procedural-workflow.md must contain procedural Markdown");
  });

  test("warns when target-specific fields are placed in core artifact frontmatter", async () => {
    const raw = await readTextFixture(join(fixtures, "target-specific-field.md"));
    const artifact = parseArtifactMarkdown(raw, "target-specific-field.md");

    expect(artifact.warnings).toContain(
      'target-specific field "allowed-tools" should live in adapter overrides',
    );
  });
  test("assimilates AGENTS.md into a reviewable profile bundle", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-"));
    try {
      const output = await runProfileV1Command([
        "assimilate",
        "--source",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
        "--name",
        "assimilated-agents",
        "--json",
      ]);
      const parsed = JSON.parse(output);

      expect(parsed.profile).toBe("assimilated-agents");
      expect(parsed.artifacts.map((artifact: { ref: string }) => artifact.ref)).toEqual([
        "artifacts/context/product-direction.md",
        "artifacts/context/architecture.md",
        "artifacts/rules/opencode.md",
        "artifacts/rules/skills.md",
        "artifacts/workflows/verification.md",
      ]);

      const manifest = await readFile(join(outDir, "gentlesmith.profile.yaml"), "utf8");
      expect(manifest).toContain("name: assimilated-agents");
      expect(manifest).toContain("adapter: markdown-managed-block");

      const workflow = await readFile(join(outDir, "artifacts", "workflows", "verification.md"), "utf8");
      expect(workflow).toContain("type: workflow");
      expect(workflow).toContain("privacy: private");
      expect(workflow).toContain("bun run typecheck");

      const rendered = await runProfileV1Command([
        "render",
        "--profile",
        join(outDir, "gentlesmith.profile.yaml"),
        "--target",
        "codex",
      ]);
      expect(rendered).toContain("# Gentlesmith Profile: assimilated-agents");
      expect(rendered).toContain("## Workflow: Verification");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("previews AGENTS.md assimilation without writing files", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-dry-"));
    try {
      const output = await runProfileV1Command([
        "assimilate",
        "--source",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
        "--dry-run",
      ]);

      expect(output).toContain("Profile assimilation preview.");
      await expect(readFile(join(outDir, "gentlesmith.profile.yaml"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });



  test("fails assimilation when AGENTS.md has no catalogable sections", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-empty-"));
    const sourcePath = join(outDir, "AGENTS.md");
    try {
      await Bun.write(sourcePath, "# AGENTS.md\n\n");

      await expect(runProfileV1Command([
        "assimilate",
        "--source",
        sourcePath,
        "--out",
        join(outDir, "out"),
      ])).rejects.toThrow("No AGENTS.md sections found to assimilate");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("refuses to write through symlinked output directories", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-dir-symlink-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-dir-outside-"));
    const sourcePath = join(outDir, "AGENTS.md");
    try {
      await Bun.write(sourcePath, "# AGENTS.md\n\n## Context\n\nDo not write through symlinked directories.\n");
      await mkdir(join(outDir, "draft"), { recursive: true });
      await symlink(outsideDir, join(outDir, "draft", "artifacts"));

      await expect(runProfileV1Command([
        "assimilate",
        "--source",
        sourcePath,
        "--out",
        join(outDir, "draft"),
      ])).rejects.toThrow("Refusing to write through symlinked profile bundle directory");
      await expect(readFile(join(outsideDir, "context", "context.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("refuses to write through dangling symlinks in the output tree", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-symlink-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-outside-"));
    const sourcePath = join(outDir, "AGENTS.md");
    const outsideTarget = join(outsideDir, "created.md");
    try {
      await Bun.write(sourcePath, "# AGENTS.md\n\n## Context\n\nDo not write through symlinks.\n");
      await mkdir(join(outDir, "draft", "artifacts", "context"), { recursive: true });
      await symlink(outsideTarget, join(outDir, "draft", "artifacts", "context", "context.md"));

      await expect(runProfileV1Command([
        "assimilate",
        "--source",
        sourcePath,
        "--out",
        join(outDir, "draft"),
      ])).rejects.toThrow("Refusing to overwrite existing profile files");
      await expect(readFile(outsideTarget, "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing assimilated profile", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-assimilate-conflict-"));
    try {
      await runProfileV1Command([
        "assimilate",
        "--source",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
      ]);

      await expect(runProfileV1Command([
        "assimilate",
        "--source",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
      ])).rejects.toThrow("Refusing to overwrite existing profile files");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

});

describe("resource graph and rendering", () => {
  test("derives graph nodes and dependency edges from manifest and artifacts", async () => {
    const profilePath = join(fixtures, "basic", "gentlesmith.profile.yaml");
    const profile = await loadProfileManifest(profilePath);
    const graph = await buildResourceGraph(profile, { baseDir: join(fixtures, "basic") });

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "safety",
      "coolify-deploy",
      "coolify-manager",
      "context7",
    ]);
    expect(graph.edges).toContainEqual({
      from: "coolify-deploy",
      to: "coolify-manager",
      reason: "requires",
      targetType: "skill",
    });
    expect(graph.edges).toContainEqual({
      from: "coolify-deploy",
      to: "coolify-api",
      reason: "requires",
      targetType: "capability",
    });
    expect(graph.capabilities.map((capability) => capability.id)).toEqual(["context7", "coolify-api"]);
    expect(graph.warnings).toEqual([]);
    expect(graph.nodes.find((node) => node.id === "safety")?.overrides).toEqual({
      "markdown-managed-block": {
        title: "Operating Safety",
      },
    });
  });

  test("renders embed, mention, and none exposure through markdown adapter", async () => {
    const profile = await loadProfileManifest(join(fixtures, "basic", "gentlesmith.profile.yaml"));
    const graph = await buildResourceGraph(profile, { baseDir: join(fixtures, "basic") });
    const rendered = renderManagedMarkdown({ graph, targetName: "codex" });
    const expected = await readTextFixture(join(fixtures, "basic", "expected", "codex.md"));

    expect(rendered.content).toBe(expected);
    expect(rendered.content).not.toContain("Context7 capability");
    expect(rendered.warnings).toEqual([]);
  });

  test("rejects Windows absolute artifact refs as non-portable", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "gentlesmith-windows-path-profile-"));
    try {
      await Bun.write(join(profileRoot, "gentlesmith.profile.yaml"), [
        "schemaVersion: 1",
        "name: windows-path-profile",
        "artifacts:",
        "  - ref: C:\\Users\\diego\\secret.md",
        "",
      ].join("\n"));

      await expect(loadProfileManifest(join(profileRoot, "gentlesmith.profile.yaml")))
        .rejects.toThrow("must be a relative path inside the profile directory");
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  test("rejects artifact refs that escape the profile directory", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "gentlesmith-escape-profile-"));
    try {
      await Bun.write(join(profileRoot, "gentlesmith.profile.yaml"), [
        "schemaVersion: 1",
        "name: escaping-profile",
        "artifacts:",
        "  - ref: ../secret.md",
        "",
      ].join("\n"));

      await expect(loadProfileManifest(join(profileRoot, "gentlesmith.profile.yaml")))
        .rejects.toThrow("must be a relative path inside the profile directory");
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  test("fails deterministically when a profile references a missing artifact", async () => {
    const profile = await loadProfileManifest(join(fixtures, "missing-ref", "gentlesmith.profile.yaml"));

    await expect(buildResourceGraph(profile, { baseDir: join(fixtures, "missing-ref") }))
      .rejects.toThrow("Artifact not found: artifacts/rules/missing.md");
  });

  test("fails deterministically when two artifacts share the same identity", async () => {
    const profile = await loadProfileManifest(join(fixtures, "duplicate", "gentlesmith.profile.yaml"));

    await expect(buildResourceGraph(profile, { baseDir: join(fixtures, "duplicate") }))
      .rejects.toThrow("Duplicate resource identity: safety");
  });

  test("fails deterministically when requires.artifacts points to an unknown artifact", async () => {
    const profile = await loadProfileManifest(join(fixtures, "dangling-requires", "gentlesmith.profile.yaml"));

    await expect(buildResourceGraph(profile, { baseDir: join(fixtures, "dangling-requires") }))
      .rejects.toThrow("Artifact dependency not found: missing-workflow required by safety");
  });

  test("blocks public exports that include private or local artifacts", async () => {
    const profile = await loadProfileManifest(join(fixtures, "private", "gentlesmith.profile.yaml"));
    const graph = await buildResourceGraph(profile, { baseDir: join(fixtures, "private") });
    const report = checkPublicExportPortability(graph);

    expect(report.exportable).toBe(false);
    expect(report.issues).toEqual([
      {
        kind: "artifact",
        artifact: "local-toolchain",
        privacy: "local",
        path: "artifacts/context/local-toolchain.md",
      },
    ]);
  });

  test("warns when artifacts require undeclared capabilities", async () => {
    const raw = await readTextFixture(join(fixtures, "basic", "artifacts", "workflows", "coolify-deploy.md"));
    const graph = await buildResourceGraph({
      schemaVersion: 1,
      name: "missing-capability",
      artifacts: [{ ref: "artifacts/workflows/coolify-deploy.md" }],
      capabilities: [],
    }, { baseDir: join(fixtures, "basic") });

    expect(raw).toContain("coolify-api");
    expect(graph.warnings).toContain("Capability dependency not declared: coolify-api required by coolify-deploy");
  });


  test("warns when capabilities are not mapped for declared targets", async () => {
    const profile = await loadProfileManifest(join(fixtures, "basic", "gentlesmith.profile.yaml"));
    const graph = await buildResourceGraph({
      ...profile,
      targets: {
        codex: { adapter: "markdown-managed-block" },
        opencode: { adapter: "markdown-managed-block" },
      },
    }, { baseDir: join(fixtures, "basic") });

    expect(graph.warnings).toContain("Capability context7 is not declared for target opencode");
  });



  test("warns when public capabilities declare local-only paths", async () => {
    const profile = await loadProfileManifest(join(fixtures, "basic", "gentlesmith.profile.yaml"));
    const graph = await buildResourceGraph({
      ...profile,
      capabilities: [{
        id: "public-local-tool",
        type: "tool",
        description: "Public tool with local path.",
        privacy: "public",
        localPaths: [{ path: "~/.config/tool/config.json" }],
      }],
    }, { baseDir: join(fixtures, "basic") });

    expect(graph.warnings).toContain("Capability public-local-tool declares localPaths but is marked public");
  });

  test("builds a conservative capability target matrix", async () => {
    const profile = await loadProfileManifest(join(fixtures, "basic", "gentlesmith.profile.yaml"));
    const matrix = buildCapabilityMatrix({
      ...profile,
      targets: {
        codex: { adapter: "markdown-managed-block" },
        opencode: { adapter: "markdown-managed-block" },
        unknown: { adapter: "markdown-managed-block" },
      },
    });

    expect(matrix).toContainEqual(expect.objectContaining({
      target: "codex",
      capability: "context7",
      type: "mcp",
      level: "detect-only",
    }));
    expect(matrix).toContainEqual(expect.objectContaining({
      target: "opencode",
      capability: "context7",
      type: "mcp",
      level: "not-declared",
    }));
    expect(matrix).toContainEqual(expect.objectContaining({
      target: "unknown",
      capability: "coolify-api",
      type: "tool",
      level: "unsupported",
    }));
  });

  test("rejects capability env values because secrets must be referenced, not stored", () => {
    expect(() => parseProfileManifest(`
schemaVersion: 1
name: unsafe
capabilities:
  - id: private-mcp
    type: mcp
    description: Unsafe MCP config.
    env:
      - name: API_KEY
        value: plaintext-secret
artifacts: []
`, "unsafe-profile.yaml")).toThrow("value is not allowed");
  });
});

describe("AGENTS.md cataloging", () => {
  test("catalogs an existing AGENTS.md into named portable artifacts without losing intent", async () => {
    const source = await readTextFixture(join(fixtures, "agents-md", "AGENTS.md"));
    const catalog = catalogAgentsMarkdown(source);

    expect(catalog.artifacts.map((artifact) => `${artifact.frontmatter.type}:${artifact.frontmatter.name}`)).toEqual([
      "context:product-direction",
      "context:architecture",
      "rule:opencode",
      "rule:skills",
      "workflow:verification",
    ]);
    expect(catalog.artifacts.find((artifact) => artifact.frontmatter.name === "verification")?.body)
      .toContain("bun run typecheck");
    expect(catalog.artifacts.find((artifact) => artifact.frontmatter.name === "product-direction")?.body)
      .toContain("forge-first customization layer");
    expect(catalog.artifacts.find((artifact) => artifact.frontmatter.name === "opencode")?.body)
      .toContain("agent.gentlesmith-*");
    expect(catalog.artifacts.find((artifact) => artifact.frontmatter.name === "skills")?.body)
      .toContain("does not build skills");
    expect(catalog.warnings).toEqual([]);
  });



  test("preserves top-level AGENTS.md preamble before first second-level section", () => {
    const catalog = catalogAgentsMarkdown("# AGENTS.md\n\nNever overwrite unknown work.\n\n## Rules\n\nAsk before destructive actions.\n");

    expect(catalog.artifacts.map((artifact) => `${artifact.frontmatter.type}:${artifact.frontmatter.name}`)).toEqual([
      "context:preamble",
      "rule:rules",
    ]);
    expect(catalog.artifacts[0].body).toContain("Never overwrite unknown work.");
    expect(catalog.warnings).toContain('section "Preamble" cataloged as context because no stronger type matched');
  });

  test("deduplicates cataloged section names before assimilation", () => {
    const catalog = catalogAgentsMarkdown("# AGENTS.md\n\n## Rules\n\nFirst.\n\n## Rules\n\nSecond.\n");

    expect(catalog.artifacts.map((artifact) => artifact.frontmatter.name)).toEqual(["rules", "rules-2"]);
  });

  test("preserves ambiguous AGENTS.md sections as context and reports ambiguity", () => {
    const catalog = catalogAgentsMarkdown("# AGENTS.md\n\n## Strange Magic\n\nDo the unusual thing.\n");

    expect(catalog.artifacts[0].frontmatter).toMatchObject({
      name: "strange-magic",
      type: "context",
    });
    expect(catalog.warnings).toEqual([
      'section "Strange Magic" cataloged as context because no stronger type matched',
    ]);
  });
});

describe("profile v1 CLI vertical", () => {
  test("renders a v1 profile through the markdown adapter without writing files", async () => {
    const output = await runProfileV1Command([
      "render",
      "--profile",
      join(fixtures, "basic", "gentlesmith.profile.yaml"),
      "--target",
      "codex",
    ]);
    const expected = await readTextFixture(join(fixtures, "basic", "expected", "codex.md"));

    expect(output).toBe(expected);
  });

  test("catalogs AGENTS.md as JSON for reviewable profile assimilation", async () => {
    const output = await runProfileV1Command([
      "catalog-agents",
      "--source",
      join(fixtures, "agents-md", "AGENTS.md"),
      "--json",
    ]);
    const parsed = JSON.parse(output);

    expect(parsed.artifacts.map((artifact: { frontmatter: { name: string } }) => artifact.frontmatter.name))
      .toContain("product-direction");
    expect(parsed.warnings).toEqual([]);
  });

  test("inspects a v1 profile as JSON for graph/portability review", async () => {
    const output = await runProfileV1Command([
      "inspect",
      "--profile",
      join(fixtures, "basic", "gentlesmith.profile.yaml"),
      "--json",
    ]);
    const parsed = JSON.parse(output);

    expect(parsed.profile.name).toBe("jarvis-portable");
    expect(parsed.capabilities.map((capability: { id: string }) => capability.id)).toEqual(["context7", "coolify-api"]);
    expect(parsed.environment).toContainEqual(expect.objectContaining({ capability: "coolify-api", name: "COOLIFY_TOKEN", secret: true }));
    expect(parsed.nodes.map((node: { id: string; exposure: string; privacy: string }) => ({
      id: node.id,
      exposure: node.exposure,
      privacy: node.privacy,
    }))).toEqual([
      { id: "safety", exposure: "embed", privacy: "public" },
      { id: "coolify-deploy", exposure: "embed", privacy: "public" },
      { id: "coolify-manager", exposure: "mention", privacy: "public" },
      { id: "context7", exposure: "none", privacy: "public" },
    ]);
    expect(parsed.portability.exportable).toBe(false);
    expect(parsed.portability.issues).toContainEqual({
      kind: "capability",
      artifact: "coolify-api",
      privacy: "private",
      path: "capabilities.coolify-api",
    });
  });

  test("inspects private/local artifacts with portability warnings", async () => {
    const output = await runProfileV1Command([
      "inspect",
      "--profile",
      join(fixtures, "private", "gentlesmith.profile.yaml"),
    ]);

    expect(output).toContain("Profile: private-profile");
    expect(output).toContain("Portability: blocked for public export");
    expect(output).toContain("- artifact: local-toolchain (local) artifacts/context/local-toolchain.md");
  });
});



describe("Profile v1 application use cases", () => {
  test("modularizes AGENTS.md into a UI-ready result model", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-app-modularize-"));
    try {
      const result = await modularizeAgentsProfile({
        sourcePath: join(fixtures, "agents-md", "AGENTS.md"),
        outDir,
        profileName: "ui-ready-profile",
        dryRun: true,
      });

      expect(result).toMatchObject({
        profileName: "ui-ready-profile",
        outDir,
        wroteFiles: false,
        targetName: "codex",
      });
      expect(result.manifestPath).toBe(join(outDir, "gentlesmith.profile.yaml"));
      expect(result.nextCommands.inspect).toContain("gentlesmith v1 inspect --profile");
      expect(result.nextCommands.render).toContain("--target codex");
      expect(result.nextCommands.exportReview).toContain("gentlesmith export --profile");
      expect(result.nextCommands.exportPublic).toContain("--public");
      expect(result.nextCommands.addTarget).toBe("gentlesmith target add codex");
      expect(result.nextCommands.bindTarget).toContain("gentlesmith target set-profile codex");
      expect(result.nextCommands.previewSync).toBe("gentlesmith sync --target codex");
      expect(result.nextCommands.applySync).toBe("gentlesmith sync --target codex --apply");
      expect(result.artifacts.map((artifact) => `${artifact.type}:${artifact.name}`)).toContain("workflow:verification");
      await expect(readFile(join(outDir, "gentlesmith.profile.yaml"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe("forge Profile v1 assimilation UX", () => {
  test("forges an AGENTS.md modularization draft through the primary forge surface", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-forge-agents-"));
    try {
      await withMutedConsole(() => runForge([
        "--from-agents",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
        "--name",
        "Jarvis Draft",
      ]));

      const manifest = await readFile(join(outDir, "gentlesmith.profile.yaml"), "utf8");
      expect(manifest).toContain("name: jarvis-draft");
      expect(manifest).toContain("adapter: markdown-managed-block");

      const rendered = await runProfileV1Command([
        "render",
        "--profile",
        join(outDir, "gentlesmith.profile.yaml"),
        "--target",
        "codex",
      ]);
      expect(rendered).toContain("# Gentlesmith Profile: jarvis-draft");
      expect(rendered).toContain("forge-first customization layer");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("rejects forge AGENTS.md names that slugify to empty", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-forge-agents-invalid-name-"));
    try {
      await expect(withMutedConsole(() => runForge([
        "--from-agents",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
        "--name",
        "!!!",
      ]))).rejects.toThrow("--name must contain at least one letter or number");
      await expect(readFile(join(outDir, "gentlesmith.profile.yaml"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("does not treat --from-agents value as a profile name", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-forge-agents-default-name-"));
    try {
      await withMutedConsole(() => runForge([
        "--from-agents",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
      ]));

      const manifest = await readFile(join(outDir, "gentlesmith.profile.yaml"), "utf8");
      expect(manifest).toContain("name: agents-md-profile");
      expect(manifest).not.toContain("name: agents-md\n");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("previews forge AGENTS.md modularization without writing", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gentlesmith-forge-agents-dry-"));
    try {
      await withMutedConsole(() => runForge([
        "--from-agents",
        join(fixtures, "agents-md", "AGENTS.md"),
        "--out",
        outDir,
        "--name",
        "Jarvis Dry",
        "--dry-run",
      ]));

      await expect(readFile(join(outDir, "gentlesmith.profile.yaml"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

async function withMutedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    return await fn();
  } finally {
    console.log = originalLog;
  }
}
