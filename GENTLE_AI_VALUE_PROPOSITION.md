# Gentlesmith → gentle-ai value proposition

## One-line pitch

Gentlesmith is the profile workbench for gentle-ai: it lets developers forge, switch, review, and share agent personas/rules/env profiles without forking or weakening the Gentle AI stack.

## Why gentle-ai should want this

gentle-ai already solves the hard infrastructure problem: install agents, configure memory, SDD, skills, MCP, backups, sync, and OpenCode integration. Gentlesmith adds a focused customization layer on top:

- richer user-controlled personas and rules;
- multiple local profiles per developer;
- fast profile switching for daily work modes;
- catalogable/exportable profile specs;
- OpenCode selectable profiles that preserve gentle-ai orchestrators;
- no dependency on a hidden model runtime or plugin bridge.

This complements gentle-ai instead of competing with it.

## Product fit

Gentle AI principle:

> Configure the ecosystem, then get out of the user's way.

Gentlesmith should follow the same principle:

```bash
gentlesmith forge debugger
gentlesmith apply debugger --apply
gentlesmith apply jarvis --apply
```

The user should not need to know where Codex, Claude, OpenCode, Cursor, or Gemini store prompts. Gentlesmith owns profile composition and safe activation; gentle-ai keeps owning the agent ecosystem.

## Boundary

Gentlesmith should not install or replace gentle-ai components.

| gentle-ai owns | gentlesmith owns |
|---|---|
| agent installation | profile composition |
| SDD orchestration | user personas/rules/env fragments |
| Engram/MCP/tool setup | local profile variants |
| skills deployment | skill references/adapted behavior |
| backups/upgrades | catalogable profile exports |
| OpenCode orchestrators | `agent.gentlesmith-*` profiles |

## OpenCode alignment

The latest gentle-ai direction explicitly supports safer OpenCode compatibility for external profile managers. Gentlesmith should use that path:

- `sync` registers local Gentlesmith profiles as OpenCode primary agents under `agent.gentlesmith-*`;
- `sync` preserves gentle-ai-owned agents and existing non-gentlesmith `default_agent`;
- `apply <profile>` sets `default_agent` only to the selected `gentlesmith-*` agent;
- purge/remove only touches Gentlesmith-owned keys.

This gives OpenCode users a native-feeling Tab-selectable profile system while preserving gentle-ai's orchestrator behavior.

## What this unlocks

### For users

- “I want debugger mode for this task.”
- “I want my normal Jarvis profile again.”
- “I want a reviewer profile without changing my whole setup.”
- “I want to export/share this profile with a teammate.”

### For gentle-ai

- A clean customization story without bloating core presets.
- A community layer for profiles, not just skills.
- A path to a future profile marketplace/catalog.
- A compatible external profile manager for OpenCode.

## Proposed integration options

### Option A — Companion CLI first

Keep Gentlesmith standalone but gentle-ai-aware.

- Lowest risk.
- Useful immediately.
- No plugin contract needed.
- Can be linked from gentle-ai docs as a community integration.

### Option B — gentle-ai TUI entry

gentle-ai exposes “Customize profiles with Gentlesmith”.

- Better UX.
- Requires stable handoff/transport decision.
- Gentlesmith still owns `~/.gentlesmith` state.

### Option C — official plugin/extension

Gentlesmith becomes an official profile workbench plugin.

- Best long-term integration.
- Requires public plugin contract and maintainership agreement.
- Should wait until companion CLI proves value.

## Recommendation

Start with **Option A**, designed so it can become **Option B** without a rewrite.

Immediate goal: make Gentlesmith a polished external profile manager that gentle-ai can safely recommend, especially for OpenCode users.

## Beta readiness checklist

- [ ] Commit and verify `apply <profile>`.
- [ ] Finalize OpenCode all-profile sync + `default_agent` activation.
- [ ] Add Browse/TUI actions for forge/apply/export.
- [ ] Update quickstart around `forge → apply → export`.
- [ ] Package/install path via npm/pnpm/bun.
- [ ] Create a short demo script for Miguel/gentle-ai maintainers.
