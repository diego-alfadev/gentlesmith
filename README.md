# gentlesmith

> Forge a custom AI agent: persona, rules, environment, and skill bundles tailored to you and your system. **Standalone or as a [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) overlay.**

**Beta (v0.2.0-beta.0).** API stabilizing. Cross-platform: macOS · Linux · Windows.

---

## What it is

A small CLI that **composes markdown fragments** (persona, rules, env) and writes them into your AI agents' system-prompt files inside a managed marker block.

```
fragments/   ← atomic markdown pieces (persona, rules, env, presets)
profiles/    ← recipes (which fragments, in which order)
targets/     ← where each profile gets rendered (one yaml per agent)
presets/     ← add-on bundles you layer on top of a profile
bin/         ← the CLI
```

Edit a fragment once → `gentlesmith --apply` → all agents updated.

The tool is designed to be **owned** — you clone the repo, customize fragments and profiles to match your setup, and the CLI renders them into every agent's config file. gentlesmith never auto-runs; `--apply` is always explicit.

---

## Installation

```bash
git clone https://github.com/diego-alfadev/gentlesmith
cd gentlesmith
bun install
gentlesmith init    # wizard: creates your local profile, offers to register the global command
```

The `init` wizard registers `gentlesmith` as a global command via `bun link` (a symlink into your repo). After that:

```bash
gentlesmith           # dry-run — preview what would change
gentlesmith --apply   # write changes to all agent config files
gentlesmith browse    # interactive TUI — explore, edit profiles, apply
gentlesmith update    # git pull + bun install (self-update)
```

---

## CLI reference

| Command | Description |
|---|---|
| `gentlesmith` | Dry-run all targets — shows what would change |
| `gentlesmith --apply` | Write changes to all agent config files |
| `gentlesmith --target <name>` | Filter to one target (combine with `--apply`) |
| `gentlesmith --force` | Override self-write guard for project-level targets |
| `gentlesmith init` | Interactive wizard: create a local profile, register global command |
| `gentlesmith add` | List available preset bundles |
| `gentlesmith add <preset>` | Layer a preset on top of your local profile |
| `gentlesmith browse` | Interactive TUI: view fragments/profiles/targets, edit, apply |
| `gentlesmith update` | Self-update: `git pull` + `bun install` in the repo |

---

## How it works

### Fragments → profiles → targets

**Fragments** (`fragments/*.md`) are atomic markdown pieces — a persona, a set of coding rules, an env description. You own them; edit freely.

**Profiles** (`profiles/*.yaml`) are recipes that list which fragments to include, in order:

```yaml
name: my-profile
include:
  - persona/jarvis
  - rules/safety
  - rules/commits
  - env/system
```

**Targets** (`targets/*.yaml`) map a profile to an agent's config file:

```yaml
agent: claude
profile: my-profile
destination: ~/.claude/CLAUDE.md
mode: prepend
```

Run `gentlesmith --apply` → gentlesmith composes the fragments, wraps them in a marker block, and writes to each destination. Existing content outside the block is preserved.

### Marker block

```md
<!-- gentle-ai-overlay:gentlesmith -->

<!-- fragment: rules/safety (repo) -->
# Safety
...

<!-- /gentle-ai-overlay:gentlesmith -->
```

Each fragment is tagged `(repo)` or `(local)` so you can see at a glance which version is active. The marker namespace coexists cleanly with gentle-ai's own markers in the same file.

---

## Targets included

| Agent | Config file | Mode | Target file |
|---|---|---|---|
| AGENTS.md (global) | `~/AGENTS.md` | prepend | `targets/agents.yaml` |
| AGENTS.md (project) | `./AGENTS.md` | prepend | `targets/agents-project.yaml` |
| Claude Code | `~/.claude/CLAUDE.md` | prepend | `targets/claude.yaml` |
| Antigravity / Gemini CLI | `~/.gemini/GEMINI.md` | prepend | `targets/antigravity.yaml` |
| OpenCode | `~/.config/opencode/AGENTS.md` | prepend | `targets/opencode.yaml` |
| Codex | `~/.codex/agents.md` | managed-block | `targets/codex.yaml` |
| Cursor | `~/.cursor/rules/*.mdc` | per-fragment | `targets/cursor.yaml` |

> **AGENTS.md** is the [Linux Foundation Agentic AI Foundation](https://agents.md/) standard, supported by 25+ agents (Copilot, Windsurf, Aider, Zed, Warp, …). Render once → all those tools read the same config. The project target (`./AGENTS.md`) renders into the current directory — when running from the gentlesmith repo itself it auto-skips (self-write guard; override with `--force`).

To add another agent, drop a `targets/<name>.yaml`:

```yaml
agent: myagent
profile: my-profile
destination: ~/.myagent/AGENTS.md
mode: prepend
```

---

## Modes

| Mode | Behavior |
|---|---|
| `prepend` | Block goes at the top. Everything below is preserved. |
| `managed-block` | Block appended/replaced at the end. Existing content above stays. |
| `per-fragment` | One file per fragment (Cursor `.mdc`). Stale files auto-deleted. |

Using gentle-ai → `prepend` recommended (overlay reads first). Standalone → either works.

### Per-fragment mode (Cursor)

When `mode: per-fragment`, destination is a **directory** (e.g. `~/.cursor/rules/`). Each fragment becomes its own `.mdc` file with Cursor-compatible YAML frontmatter:

```mdc
---
description: "Safety rules"
alwaysApply: false
---
<!-- gentle-ai-overlay:gentlesmith fragment=rules/safety -->
# Safety
...
```

Fragment frontmatter keys `description`, `globs`, and `alwaysApply` pass through. If `description` is absent, it's synthesized from the first `#` heading. gentlesmith-internal keys (`scope`, `condition`) are stripped.

**Stale cleanup**: remove a fragment from your profile, re-apply → the corresponding `.mdc` is deleted automatically (identified by the marker comment).

---

## Profiles included

| Profile | What it composes |
|---|---|
| `jarvis` | Full stack — identity + Karpathy thinking guidelines + safety/workflow/commits/tools rules + system/toolchain/deployment env |
| `surgical` | Minimal — rules only, no persona, no env |

These are examples. The expectation is you write your own (or start from `jarvis` via the wizard and trim). New community profiles welcome via PR.

---

## Init wizard

```bash
gentlesmith init
```

Five questions, under two minutes:

1. **Handle** — your name/handle, used as the profile slug (`profiles/local-<handle>.yaml`)
2. **Base profile** — `jarvis`, `surgical`, or `custom` (empty)
3. **Env fragments** — include `env/system` and `env/toolchain`?
4. **Working directory** — optional project path for a custom env context fragment
5. **Skill packages** — optional `npx skills` packages to declare

Preview + confirm before any file is written. `Ctrl-C` aborts cleanly. On first run, the wizard offers to register `gentlesmith` as a global command via `bun link`.

---

## Add command — preset bundles

Layer a preset on top of your local profile without editing YAML manually:

```bash
gentlesmith add                  # list available presets
gentlesmith add critical-judge   # merge preset into your local profile
gentlesmith --apply              # render the updated profile
```

Presets live in `presets/*.yaml`. Each declares `include` and/or `skills` entries merged into your newest `profiles/local-*.yaml`. Idempotent — re-running shows "already applied" if nothing new.

Bundled presets:

| Preset | What it adds |
|---|---|
| `critical-judge` | `rules/critical-review` — structured PR review, not rubber-stamp approval |
| `tdd-strict` | `rules/tdd-strict` — red-green-refactor TDD discipline |

Personal presets go in `presets/local-*.yaml` (gitignored).

---

## Personal overrides without forking

Drop your version of any fragment under `fragments-local/` (gitignored) — it overrides the same path in `fragments/` automatically:

```bash
mkdir -p fragments-local/persona
cp fragments/persona/jarvis.md fragments-local/persona/jarvis.md
# Edit freely
gentlesmith --apply
```

Each rendered fragment is tagged `(local)` or `(repo)` so you can see which version your agent is reading.

---

## Skill levels (where things live)

| Level | Where | Context cost | Example |
|---|---|---|---|
| 1. **Forged** | Full text in the overlay block | Always loaded | persona, safety rules |
| 2. **In-block reference** | Trigger mentioned inside the block | Just the reference | "Run `/judgment-day` on PRs" |
| 3. **Manifest** | `skills:` list in the profile | Minimal metadata | `skills: [react-19]` |
| 4. **Ambient** | Agent discovers via skill registry | Zero | Skills in `~/.claude/skills/` |

Levels 1–3 are implemented. Level 4 is delegated to [`npx skills`](https://skills.sh).

---

## Skills bridge

Profiles can declare task-level capabilities installed via [Vercel's `npx skills`](https://skills.sh):

```yaml
# profiles/my-profile.yaml
include:
  - persona/jarvis
  - rules/safety
skills:
  - vercel-labs/react-19
  - vercel-labs/a11y-review
```

On `--apply`, gentlesmith forwards each package to `npx skills add <pkg>`. It does not maintain its own registry. If `npx skills` is not installed, the bridge logs a warning and continues.

**Positioning**: gentlesmith manages *who the agent IS* (persona, rules, env). `npx skills` manages *what the agent can DO* (task-level capabilities). Complementary, not overlapping.

---

## Scoped fragments

Fragments can render only for specific targets via YAML frontmatter:

```md
---
scope: agents
---
# Only renders in the `agents` target (~/AGENTS.md)
```

`scope` accepts a string or a list: `scope: [agents, claude]`. Useful for tool-specific instructions that don't belong in every output.

---

## Coexistence with gentle-ai

gentlesmith and gentle-ai write to the same files but in **separate namespaces**:

```md
<!-- gentle-ai-overlay:gentlesmith -->
... your forged content ...
<!-- /gentle-ai-overlay:gentlesmith -->

<!-- gentle-ai:persona -->
... gentle-ai's persona ...
<!-- /gentle-ai:persona -->
```

`gentle-ai sync` is namespace-aware — it doesn't touch the `gentlesmith` overlay block. gentlesmith doesn't touch gentle-ai's blocks.

To replace gentle-ai's default persona with yours:

```bash
gentle-ai uninstall --agent claude-code --component persona --yes
gentlesmith --apply
```

Or use `--persona custom` when installing gentle-ai to skip persona injection from the start.

---

## Threat model

gentlesmith writes content into files that AI agents read on every conversation:

1. **Trust your fragments**. Fragment edits are like editing your shell rc — they become standing instructions for every session.
2. **Don't render fragments from untrusted sources**. A malicious fragment can manipulate agent behavior across all sessions. Review PRs carefully before merging.
3. **The marker block is targetable**. An attacker with write access to a managed file can inject content. Mitigation: `--apply` is explicit and never auto-runs.
4. **Skill packages run external code**. `npx skills add` executes Vercel's CLI. Audit packages before declaring them — see [Vercel's security advisory on hallucinated skills](https://www.aikido.dev/blog/agent-skills-spreading-hallucinated-npx-commands).
5. **Secrets stay out of fragments**. Use `~/.secrets.agents` for tokens; they're sourced by your shell, not rendered into agent context.

---

## Roadmap

- [x] Fragment composition + distribute (v0.1)
- [x] `prepend` and `managed-block` modes with namespace-aware coexistence
- [x] Cross-platform (macOS / Linux / Windows)
- [x] AGENTS.md target (Linux Foundation cross-tool standard)
- [x] `init` wizard — interactive entrypoint with `bun link` offer
- [x] Skill level 2 — scoped fragments via frontmatter
- [x] Skill level 3 — `skills:` manifest, bridge to `npx skills`
- [x] Skill level 4 — delegated to `npx skills` ecosystem
- [x] `add` command — preset bundles on top of local profiles
- [x] OpenCode target
- [x] Cursor per-fragment rendering (`mode: per-fragment`, `.mdc` with frontmatter projection)
- [x] Project-level AGENTS.md target (with self-write guard)
- [x] `gentlesmith update` — self-update via git pull
- [x] TUI browser — `gentlesmith browse` to explore, edit profiles, and apply interactively
- [ ] Discovery flow for `~/.secrets.agents` and `~/.zshrc.agents`
- [ ] More targets (Windsurf, Kiro, Kimi, Qwen)
- [ ] Formal PR to gentle-ai documenting the `gentle-ai-overlay:*` namespace contract
- [ ] Community gallery of profiles and presets

---

## Status

Beta. Seven targets across three rendering modes, `init` wizard, `add` presets, `update` command, scoped fragments, skills bridge. The CLI surface is stabilizing; the marker namespace (`gentle-ai-overlay:gentlesmith`) is stable.

---

## License

MIT
