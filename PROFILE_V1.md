# Gentlesmith Profile v1

Profile v1 is the portable profile foundation for Gentlesmith.

It is experimental, intentionally small, and designed around this rule:

> Keep the portable source neutral; put target-specific behavior in adapters or overrides.

## Mental model

```text
gentlesmith.profile.yaml
  -> references artifacts
artifacts/*.md
  -> neutral frontmatter + markdown body
ResourceGraph
  -> derived internal validation/rendering graph
target adapters
  -> Codex / Claude / OpenCode / Pi-specific output
```

Users author the manifest and artifacts. Gentlesmith derives the graph. Artifact refs must stay inside the profile directory; absolute paths and `..` traversal are rejected.

## Manifest

```yaml
schemaVersion: 1
name: jarvis-portable
description: Portable Jarvis profile for coding agents.
capabilities:
  - id: context7
    type: mcp
    description: Fetch current library documentation through Context7.
    privacy: public
    targets: [codex, claude]
  - id: coolify-api
    type: tool
    description: Access Coolify through user-provided credentials.
    privacy: private
    env:
      - name: COOLIFY_TOKEN
        required: true
        secret: true
        description: Coolify API token from the local environment.
artifacts:
  - ref: artifacts/rules/safety.md
    exposure: embed
  - ref: artifacts/skills/coolify-manager.md
    exposure: mention
targets:
  codex:
    adapter: markdown-managed-block
```

## Capabilities

Capabilities are first-class profile resources. They describe what the harness needs, not just what the agent should be told.

Supported capability types:

- `mcp`
- `tool`
- `command`
- `hook`
- `memory`

A capability can declare target applicability and environment references:

```yaml
capabilities:
  - id: context7
    type: mcp
    description: Fetch current library documentation through Context7.
    privacy: public
    targets: [codex, claude]
  - id: coolify-api
    type: tool
    description: Access Coolify through user-provided credentials.
    privacy: private
    env:
      - name: COOLIFY_TOKEN
        required: true
        secret: true
        description: Coolify API token from the local environment.
    localPaths:
      - path: ~/.config/coolify/config.json
        required: false
        description: Optional local Coolify CLI config.
```

Rules:

- Store environment variable names, never secret values.
- `env[].value` is rejected. Use `${env:NAME}` semantics at adapter/render time instead.
- Artifacts can require capabilities by id through `requires.capabilities`.
- Missing capability declarations are graph warnings today; adapter-specific writes come later.
- `localPaths` are always treated as machine-specific. Public capabilities with local paths produce warnings.

### Capability target matrix

`gentlesmith v1 inspect` also derives a conservative matrix for declared targets.

Current levels:

| Level | Meaning |
|---|---|
| `detect-only` | Gentlesmith can model, inspect, and warn, but does not write target-specific config yet. |
| `not-declared` | The capability has an explicit `targets` list and the profile target is not included. |
| `unsupported` | Gentlesmith has no matrix entry for that target yet. |
| `adapter-managed` | Reserved for future adapters that safely write target-specific config. |

This is intentionally conservative: the matrix prevents false portability claims before adapter-specific MCP/tool/hook writes exist.

## Artifact frontmatter

Required:

```yaml
name: safety
type: rule
description: Safety and reversible-action rules.
```

Optional:

```yaml
tags: [safety, workflow]
requires:
  skills:
    - coolify-manager
  capabilities:
    - shell
  artifacts:
    - deployment-checklist
privacy: public
```

Supported artifact types:

- `rule`
- `workflow`
- `prompt`
- `context`
- `skill-ref`
- `capability-ref`

## Exposure

Profile references decide how an artifact is rendered:

| Exposure | Meaning |
|---|---|
| `embed` | Include the artifact body directly in target output. |
| `mention` | Render a compact reference/hint. Useful for skills. |
| `none` | Track in the graph but do not render directly. |

## Privacy

| Privacy | Meaning |
|---|---|
| `public` | Safe to export/share. |
| `private` | User-specific but usable locally. |
| `local` | Machine/environment-specific and non-portable. |

Public exports must surface `private` and `local` artifacts before packaging.

## Target-specific optimization

Do not put target-specific fields in portable artifact frontmatter:

```yaml
allowed-tools: Bash # Claude-specific: do not put this in core artifact metadata
model: claude-sonnet # target-specific
agent: build # target-specific
```

Use manifest/adapter overrides instead:

```yaml
artifacts:
  - ref: artifacts/rules/safety.md
    exposure: embed
    overrides:
      markdown-managed-block:
        title: Operating Safety
```

## Experimental commands

Render a v1 profile through the current Markdown adapter:

```bash
gentlesmith v1 render \
  --profile tests/fixtures/profile-v1/basic/gentlesmith.profile.yaml \
  --target codex
```

Inspect the derived graph and portability report:

```bash
gentlesmith v1 inspect \
  --profile tests/fixtures/profile-v1/basic/gentlesmith.profile.yaml

gentlesmith v1 inspect \
  --profile tests/fixtures/profile-v1/basic/gentlesmith.profile.yaml \
  --json
```

Preview cataloging an existing `AGENTS.md`:

```bash
gentlesmith v1 catalog-agents --source AGENTS.md --json
```

Assimilate an existing `AGENTS.md` into a reviewable profile bundle directly:

```bash
gentlesmith v1 assimilate \
  --source AGENTS.md \
  --out .gentlesmith-v1-draft \
  --name jarvis-draft
```

The primary product entry point is `forge --from-agents`, backed by the `modularizeAgentsProfile` application use case so CLI, Browse, and future UI layers share the same behavior:

```bash
gentlesmith forge --from-agents AGENTS.md --out .gentlesmith-v1-draft --name jarvis-draft
```

`assimilate` and `forge --from-agents` write `gentlesmith.profile.yaml` plus `artifacts/**.md`. Imported sections are marked `privacy: private` by default because existing agent files often contain personal or machine-specific behavior. It refuses to overwrite existing profile files; use a fresh output directory when iterating. Add `--dry-run` to preview without writing. The same flow is available in `gentlesmith browse` as “Modularize AGENTS.md into Profile v1 draft”.

This is the proof test for Profile v1: an existing agent bible should become named portable pieces without losing intent. Top-level preamble before the first `##` is preserved as a `context:preamble` artifact.

## Current status

Implemented and tested:

- neutral manifest parsing
- artifact frontmatter parsing
- target-specific frontmatter warnings
- workflow procedural validation
- ResourceGraph derivation
- first-class capability resources for MCPs/tools/commands/hooks/memory
- conservative capability target matrix in `v1 inspect`
- capability dependency warnings when artifacts require undeclared capabilities
- env contract validation that rejects stored secret values
- local-only path references for machine-specific capability requirements
- duplicate identity detection
- dangling `requires.artifacts` validation
- privacy/portability checks
- profile graph inspection
- markdown managed-block rendering
- AGENTS.md cataloging
- AGENTS.md assimilation into a reviewable profile bundle
- experimental `gentlesmith v1 render`
- experimental `gentlesmith v1 inspect`
- experimental `gentlesmith v1 catalog-agents`
- experimental `gentlesmith v1 assimilate`
- product-facing `gentlesmith forge --from-agents` and Browse entry point

Not yet wired as the default:

- `gentlesmith sync`
- `gentlesmith export`
- richer Claude/OpenCode/Pi adapters
