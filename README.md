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

`forge` bootstraps `~/.gentlesmith` if needed, discovers your local gentle-ai/toolchain context, and writes a self-contained Workbench bundle to create or refine a profile.

Then inspect/apply from the cockpit:

```bash
gentlesmith browse
```

Or use the advanced CLI:

```bash
gentlesmith apply debugger # preview switching enabled targets to local-debugger/debugger
gentlesmith sync          # dry-run render
gentlesmith export        # write a catalogable profile export
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

Gentlesmith is multi-profile by design:

- you can forge many local profiles
- targets choose which profile they render
- `sync` applies the profiles currently bound to installed targets
- `apply <profile>` switches enabled targets to a profile, with preview by default
- a profile can be exported, catalogued, or used for sub-agents/framework agents without ever being synced into your main local agents

## Commands

Primary:

| Command | Purpose |
|---|---|
| `gentlesmith forge` | Bootstrap if needed, then start LLM-led profile forging |
| `gentlesmith apply <profile>` | Preview/switch active profile for enabled targets |
| `gentlesmith patch` | Create a self-contained patch bundle for profile changes |
| `gentlesmith browse` | Inspect/edit profiles, fragments, skills, targets, and apply |

Advanced:

| Command | Purpose |
|---|---|
| `gentlesmith init` | Deterministic runtime bootstrap only |
| `gentlesmith sync [--apply]` | Preview or write installed targets |
| `gentlesmith export [--profile <profile>]` | Export a catalogable profile spec, sources, rendered prompts, and diffs |
| `gentlesmith target ...` | Manage installed target definitions |
| `gentlesmith preset ...` | Apply fragment bundles |
| `gentlesmith skills ...` | Discover/list/reference skills; no skill builder |
| `gentlesmith migrate` | Explicit legacy local-state migration |
| `gentlesmith update` | Update a git-clone install |

## Apply vs sync vs targets

`targets` are low-level bindings: “render profile X into destination Y”.

Most users should not need to think about them every day:

```bash
gentlesmith apply debugger          # preview switch to local-debugger/debugger
gentlesmith apply debugger --apply  # write target bindings and rendered outputs
gentlesmith apply jarvis --apply    # switch back
```

By default, `apply` switches enabled targets. For OpenCode, that means Gentlesmith registers local profiles as selectable primary agents and sets `default_agent` to the selected profile.

Use explicit targets when needed:

```bash
gentlesmith apply debugger --target codex
gentlesmith apply debugger --target opencode --apply # set OpenCode default_agent
gentlesmith sync --target codex                      # render only one target
gentlesmith target set-profile codex local-debugger  # low-level binding
```

`sync` always means: render the profiles currently bound to installed targets. It does not choose a new profile for you.

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

## gentle-ai bridge status

Gentlesmith is bridge-ready, not bridge-dependent.

Today:

- `forge`/`patch` produce self-contained bundles.
- You can hand `handoff.md` to any coding agent manually.
- If gentle-ai is detected, forge includes `sources/gentle-ai-bridge.md` explaining the current boundary.

Not implemented yet:

- no hidden gentle-ai plugin transport
- no TUI tunneling into gentle-ai
- no assumption that gentle-ai owns Gentlesmith state

That keeps Gentlesmith usable standalone while leaving a clean path for a future gentle-ai TUI/plugin integration.

See `GENTLE_AI_VALUE_PROPOSITION.md` for the integration proposal.

## Forge

Default `forge` is LLM-first.

It does not invent its own model runtime. Instead it prepares a self-contained Workbench bundle with:

- current profile
- detected tools and agents
- recommended integration fragments
- reusable env baseline when available
- local skill roots and L0-L3 skill incorporation guidance
- gentle-ai bridge-readiness notes when gentle-ai is detected
- exact files the LLM should propose writing under `~/.gentlesmith`

Examples:

```bash
gentlesmith forge --name local-debugger --from jarvis
gentlesmith forge --profile local-diego
gentlesmith forge --name local-reviewer --from jarvis --env-from local-diego
gentlesmith forge --name mastra-worker --from surgical --env agnostic
```

Env behavior:

- default `--env inherit` preserves useful `env/*` fragments from an existing local profile when forging variants
- `--env-from <profile>` chooses the profile that provides that baseline
- `--env agnostic` keeps the forged profile portable for orchestrators, sub-agents, framework agents, or catalogued exports

Default forge writes under:

```text
~/.gentlesmith/forges/<timestamp-profile>/
├── handoff.md
├── context.json
├── README.md
└── sources/
```

Manual deterministic fallback:

```bash
gentlesmith forge --manual
```

## Golden use: patch a profile safely

Use this when you want to add a behavior tweak without risking your current agent setup.

Example: adapt an installed skill such as `grill-me` into a lighter profile behavior.

Guided bundle flow:

```bash
gentlesmith patch --profile local-diego --from-skill grill-me --level adapted
```

This writes:

```text
~/.gentlesmith/patches/<timestamp-slug>/
├── handoff.md
├── context.json
├── README.md
└── sources/
```

Give `handoff.md` to your agent. It contains enough Gentlesmith context to propose/write runtime-local fragments and profile edits without needing the repo cloned.

Manual flow:

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

## Catalogued exports

`export` is not only for your active local targets. It writes a reviewable profile package that can be shared, compared, or used as the seed for future catalog/marketplace workflows.

```bash
gentlesmith export --profile local-diego
gentlesmith export --profile local-debugger --out /tmp/local-debugger-export
```

Each export includes:

- `catalog.json` — machine-readable export metadata
- `profile.yaml` / `profile.json` — the profile spec
- `source-fragments/` — copied source fragments used by the profile
- `rendered/` and `diffs/` — only when installed targets bind to that profile
- `summary.md` and `CHANGELOG.md` — human review files

If no installed target currently uses the profile, export still succeeds. That is intentional: profiles can be specs for sub-agents, orchestrators, framework agents, or future target binding.

## OpenCode profiles

When the OpenCode target is installed, Gentlesmith syncs local profiles as selectable primary agents:

```text
agent.gentlesmith-diego
agent.gentlesmith-reviewer
agent.gentlesmith-surgical
```

`gentlesmith apply debugger --apply` also sets:

```json
{
  "default_agent": "gentlesmith-debugger"
}
```

This follows gentle-ai's OpenCode direction: profiles should appear in OpenCode without the user memorizing a separate registration step.

gentlesmith only owns `agent.gentlesmith-*` keys and `default_agent` when it points to a `gentlesmith-*` agent in `~/.config/opencode/opencode.json`.

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

Forge bundles include `sources/skills-discovery.md`, which lists installed skills found in known roots and reminds the receiving agent how to apply L0-L3 skill semantics.

### Four ways to use a skill

Keep the default profile lean. Add only the amount of behavior you actually want:

| Level | Use | Good for |
|---|---|---|
| Install-only | Discover it; invoke it manually when needed. | Large/specialized skills |
| Reference | Add compact local `references/<slug>` when-to-use guidance for an installed/external skill. | `think-through`-style skill for new projects, paradigm shifts, or rabbit-hole risk |
| Adapted fragment | Extract a short behavior block into persona/rules/workflows. | Light `grill-me` behavior in `persona/learning-coach` |
| Embedded rule/persona | Make it part of the base contract. | Jarvis-style no-yes-man judgment |

Default Gentlesmith built-ins are intentionally low-intrusion. Richer behavior should be opt-in through fragments or local profiles.

For now, `skills:` stays a simple metadata/package list. Do not use structured skill objects yet; put durable when-to-use behavior in local `references/` fragments.

Do not vendor third-party skills into Gentlesmith built-ins. Install/reference them from upstream instead, for example:

```bash
npx skills add https://github.com/neonwatty/claude-interview-skills/ --skill think-through
```

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
