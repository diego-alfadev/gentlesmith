# gentlesmith — Agent Context

## Product Direction

gentlesmith is the forge-first customization layer for AI coding agents.

## Architecture

Package assets live in `fragments/`, `profiles/`, `targets/`, and `presets/`.

## OpenCode

gentlesmith may create/update only `agent.gentlesmith-*`.

## Skills

gentlesmith does not build skills. It may discover, list, reference, toggle, or install existing skills.

## Verification

Use:

```bash
bun run typecheck
GENTLESMITH_HOME=/tmp/gentlesmith-smoke bun run bin/distribute.ts init
GENTLESMITH_HOME=/tmp/gentlesmith-smoke bun run bin/distribute.ts sync
```
