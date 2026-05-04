# gentlesmith

`gentlesmith` is the profile forge for AI coding agents.

It composes reusable fragments — persona, rules, workflows, environment hints, and integrations — into local agent profiles you can apply to Codex, Claude, Cursor, OpenCode, Gemini/Antigravity, and other targets.

It is designed to work **with gentle-ai** by default, but it does not require gentle-ai to run.

## Why it exists

AI agents are easy to install. They are harder to make yours.

gentle-ai owns the infrastructure layer: orchestration, SDD, Engram, MCP tools, model profiles, and agent setup.

gentlesmith owns the user-behavior layer:

- how your agent communicates
- which rules it follows
- what local environment assumptions it can use
- which fragments compose each profile
- which profile gets applied to which agent target
- which profiles should be selectable in OpenCode

## Quickstart

```bash
# once published
bun add -g gentlesmith

# current local repo workflow
bun link

# first real command
gentlesmith forge
```

`forge` bootstraps `~/.gentlesmith` if needed, discovers your local gentle-ai/toolchain context, and prints an LLM handoff to create or refine your profile.

Then inspect/apply from the cockpit:

```bash
gentlesmith browse
```

Or use the advanced CLI:

```bash
gentlesmith sync          # dry-run render
gentlesmith export        # write rendered prompts + diffs to a sandbox folder
gentlesmith sync --apply  # write overlays / selectable profile entries
```

## Core model

```text
package assets                 runtime state
--------------                 -------------
fragments/                     ~/.gentlesmith/fragments-local/
profiles/                      ~/.gentlesmith/profiles/
targets/                       ~/.gentlesmith/targets/
presets/                       ~/.gentlesmith/presets/
```

Built-ins live in the installed package. Personal machine state lives in `~/.gentlesmith`.

## Commands

Primary:

| Command | Purpose |
|---|---|
| `gentlesmith forge` | Bootstrap if needed, then start LLM-led profile forging |
| `gentlesmith browse` | Inspect/edit profiles, fragments, skills, targets, and apply |

Advanced:

| Command | Purpose |
|---|---|
| `gentlesmith init` | Deterministic runtime bootstrap only |
| `gentlesmith sync [--apply]` | Preview or write installed targets |
| `gentlesmith export [--profile <profile>]` | Export rendered prompts and diffs to a sandbox folder |
| `gentlesmith target ...` | Manage installed target definitions |
| `gentlesmith preset ...` | Apply fragment bundles |
| `gentlesmith skills ...` | Discover/list/reference skills; no skill builder |
| `gentlesmith migrate` | Explicit legacy local-state migration |
| `gentlesmith update` | Update a git-clone install |

## Discovery

gentlesmith builds an internal `DiscoverySnapshot` under the hood. It detects:

- gentle-ai
- OpenCode
- Codex / Claude / Gemini / Cursor configs
- Engram
- Context7 MCP
- SDD/GGA skills
- installed skills in known roots

Discovery drives recommended fragments, targets, and skill references. There is no separate public `gentlesmith gentle` namespace.

## Forge

Default `forge` is LLM-first.

It does not invent its own model runtime. Instead it prepares a high-signal handoff with:

- current profile
- detected tools and agents
- recommended integration fragments
- local skill roots
- exact files the LLM should propose writing under `~/.gentlesmith`

Manual deterministic fallback:

```bash
gentlesmith forge --manual
```

## Golden use: patch a profile safely

Use this when you want to add a behavior tweak without risking your current agent setup.

Example: adapt an installed skill such as `grill-me` into a lighter profile behavior.

```bash
# 1. Discover what exists
gentlesmith skills discover

# 2. Create or edit a small local fragment
# ~/.gentlesmith/fragments-local/persona/learning-coach.md

# 3. Add that fragment to the profile
# ~/.gentlesmith/profiles/local-diego.yaml

# 4. Preview and export before applying
gentlesmith sync
gentlesmith export --profile local-diego

# 5. Apply only after reviewing summary.md and diffs/
gentlesmith sync --apply
```

Rule of thumb:

- Put durable behavior in a fragment, not directly in generated `AGENTS.md` output.
- Keep installed skills as references/capabilities; adapt only the small behavioral essence into persona/rules.
- Prefer local fragments for machine/user-specific taste.
- Use `export` whenever a change affects an existing profile.

## OpenCode selectable profiles

The OpenCode target can register profiles as selectable primary agents:

```text
agent.gentlesmith-diego
agent.gentlesmith-reviewer
agent.gentlesmith-surgical
```

gentlesmith only owns `agent.gentlesmith-*` keys in `~/.config/opencode/opencode.json`.

It must not modify gentle-ai-owned keys such as:

- `gentle-orchestrator`
- `sdd-*`
- `sdd-orchestrator-*`

## Skills

gentlesmith does **not** build skills.

It discovers and references installed/global skills from known roots such as:

- `~/.config/opencode/skills`
- `~/.codex/skills`
- `~/.claude/skills`
- `~/.agents/skills`

Use gentle-ai or an external skill builder/installer to create skills, then use gentlesmith to reference or toggle them in profiles.

### Four ways to use a skill

Keep the default profile lean. Add only the amount of behavior you actually want:

| Level | Use | Good for |
|---|---|---|
| Install-only | Discover it; invoke it manually when needed. | Large/specialized skills |
| Reference | Tell the profile when to suggest it. | `think-through` for new projects, paradigm shifts, or rabbit-hole risk |
| Adapted fragment | Extract a short behavior block. | Light `grill-me` behavior in `persona/learning-coach` |
| Embedded rule/persona | Make it part of the base contract. | Jarvis-style no-yes-man judgment |

Default Gentlesmith built-ins are intentionally low-intrusion. Richer behavior should be opt-in through fragments or local profiles.

## Coexistence with gentle-ai

gentlesmith writes only its own managed overlay markers:

```html
<!-- gentle-ai-overlay:gentlesmith -->
...
<!-- /gentle-ai-overlay:gentlesmith -->
```

For per-fragment targets it writes files containing:

```html
<!-- gentle-ai-overlay:gentlesmith fragment=<ref> -->
```

It does not edit unrelated gentle-ai blocks.

## Status

Pre-release. No compatibility promises yet. The priority is product clarity and a clean forge-first runtime.
