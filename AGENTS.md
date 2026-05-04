# gentlesmith — Agent Context

## Product Direction

gentlesmith is the forge-first customization layer for AI coding agents.

It is gentle-ai-first but dependency-optional:

```text
gentle-ai    -> runtime, orchestration, SDD, tools, MCP, installation
gentlesmith  -> persona, rules, env, profile composition, target binding
```

The intended happy path is:

```bash
gentlesmith forge
gentlesmith browse
gentlesmith sync --apply
```

`forge` bootstraps runtime if needed. `init` is deterministic bootstrap only.

## Architecture

Package assets:

- `fragments/` — built-in markdown fragments
- `profiles/` — built-in YAML recipes
- `targets/` — built-in target templates
- `presets/` — built-in bundles

Runtime state:

- `~/.gentlesmith/fragments-local/`
- `~/.gentlesmith/profiles/`
- `~/.gentlesmith/targets/`
- `~/.gentlesmith/state.yaml`

Never write user-specific machine state into package built-ins.

## Discovery

`bin/discovery.ts` owns the internal `DiscoverySnapshot`.

Discovery detects:

- gentle-ai
- OpenCode/Codex/Claude/Gemini/Cursor
- Engram
- Context7
- SDD/GGA
- known skill roots

Do not reintroduce a user-facing `gentlesmith gentle` namespace. Discovery should happen under the hood.

## OpenCode

gentlesmith may create/update only:

```text
agent.gentlesmith-*
```

Do not modify:

- `gentle-orchestrator`
- `sdd-*`
- `sdd-orchestrator-*`

OpenCode writes must be safe: parse first, write temp, rename, and fail without partial writes when JSON is malformed.

## Skills

gentlesmith does not build skills.

It may discover, list, reference, toggle, or install existing/package skills. If a user wants to create a skill, point them to gentle-ai or a dedicated skill builder.

## Verification

Use:

```bash
bun run typecheck
GENTLESMITH_HOME=/tmp/gentlesmith-smoke bun run bin/distribute.ts init
GENTLESMITH_HOME=/tmp/gentlesmith-smoke bun run bin/distribute.ts sync
```

Do not run builds unless explicitly asked. Do not commit or push unless explicitly asked.
