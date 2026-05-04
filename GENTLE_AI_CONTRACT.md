# gentle-ai ↔ gentlesmith contract

gentlesmith is gentle-ai-first, but not gentle-ai-dependent.

## Ownership split

| Area | Owner |
|---|---|
| Runtime/toolchain installation | gentle-ai |
| SDD orchestration and phase agents | gentle-ai |
| Engram/Context7/MCP setup | gentle-ai unless explicitly delegated |
| User persona/rules/env/profile composition | gentlesmith |
| Local profile-to-target binding | gentlesmith |
| OpenCode selectable user profiles | gentlesmith, under `agent.gentlesmith-*` only |

## Marker namespace

gentlesmith writes only:

```html
<!-- gentle-ai-overlay:gentlesmith -->
...
<!-- /gentle-ai-overlay:gentlesmith -->
```

Per-fragment targets may write:

```html
<!-- gentle-ai-overlay:gentlesmith fragment=<ref> -->
```

gentlesmith must not edit unrelated `gentle-ai:*` blocks or non-gentlesmith content.

## Runtime state

Mutable state lives in:

```text
~/.gentlesmith
```

Package assets are templates. Runtime files are user-owned.

## Discovery

gentlesmith performs internal discovery of gentle-ai-adjacent tools:

- gentle-ai
- Engram
- Context7
- SDD/GGA skills
- OpenCode/Codex/Claude/Gemini/Cursor configs
- known global skill roots

Discovery is under the hood. Users should not need a `gentlesmith gentle` namespace.

## OpenCode

gentle-ai owns:

- `gentle-orchestrator`
- `sdd-*`
- `sdd-orchestrator-*`

gentlesmith may create/update/delete only:

```text
agent.gentlesmith-*
```

These agents represent rich gentlesmith profiles selectable from OpenCode.

## Skills

gentlesmith does not build skills.

It may:

- discover installed skills
- reference/toggle skills in profiles
- forward package refs to a skills.sh-compatible installer when explicitly applied

Skill creation remains external: gentle-ai, skills.sh, or another dedicated builder.

## Forge boundary

`gentlesmith forge` is the primary entrypoint. It may bootstrap runtime and prepare an LLM handoff/interview.

Until gentle-ai exposes a stable local agent/plugin invocation contract, gentlesmith must not require a model runtime. It should produce precise handoff prompts and local file proposals instead.
