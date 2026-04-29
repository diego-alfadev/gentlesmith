# gentlesmith

> Forge a custom AI agent: persona, rules, environment, and skill bundles tailored to you and your system. **Standalone or as a [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) overlay.**

> ⚠️ **Alpha (v0.1.0-alpha).** API may shift. Use it, file issues, suggest things. The architecture is settling.

Cross-platform: macOS · Linux · Windows.

---

## What it is

A small CLI that **composes markdown fragments** (persona, rules, env, skill manifests) and writes them into your AI agent's system-prompt file inside a managed marker block.

The interesting part isn't the catalog of fragments — it's how they compose. You define **profiles** (recipes) and the tool renders them across **all your agents** (Claude Code, Codex, Antigravity/Gemini, OpenCode, Cursor, etc.) with one command.

```
fragments/   ← atomic markdown pieces (persona, rules, env)
profiles/    ← recipes (which fragments, in which order)
targets/     ← where each profile gets rendered (one yaml per agent)
bin/         ← the renderer
```

Update a fragment once → run `gentlesmith --apply` → all agents updated.

---

## Why "gentlesmith"

It plays nice with [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) but doesn't depend on it.

- **Using gentle-ai?** gentlesmith writes inside its own marker namespace (`<!-- gentle-ai-overlay:gentlesmith -->`). gentle-ai's `sync` leaves it alone. The two coexist in the same file.
- **Not using gentle-ai?** gentlesmith works standalone. It's just a markdown composer that writes to your agent's config file.

---

## Quick start (alpha)

```bash
# Try without installing
npx -y github:diego-alfadev/gentlesmith

# Or clone for hacking
git clone https://github.com/diego-alfadev/gentlesmith
cd gentlesmith
bun install
bun run distribute            # dry-run: see what would change
bun run distribute --apply    # write to all configured agents
```

For dialogic onboarding (let an agent interview you and write your fragments): see [ONBOARDING-PROMPT.md](ONBOARDING-PROMPT.md).

For environment setup details (`~/.secrets.agents` pattern, etc.): see [SETUP.md](SETUP.md).

---

## Skill levels (where things live)

A profile can declare four levels of "where the skill/workflow ends up":

| Level | Where | Cost in context | Example |
|---|---|---|---|
| 1. **Forged** | Full text inside the overlay block | Always loaded | Karpathy guidelines, safety rules, persona |
| 2. **In-block reference** | Mentioned by trigger inside the block | Just the reference | "Run `/judgment-day` when reviewing PRs" |
| 3. **Manifest** | Declared in a YAML frontmatter or footer block | Minimal metadata | `skills: [react-19, a11y-review]` |
| 4. **Ambient** | Not in our block at all — agent discovers via skill registry | Zero | Skills installed under `~/.claude/skills/` |

V0.1 implements only **level 1 (forged)**. Levels 2–4 are part of the schema but not yet rendered.

---

## Personal overrides without forking

Don't want to fork the repo just to tweak a fragment? Drop your version under `fragments-local/` (gitignored) — it overrides the same path in `fragments/` automatically.

```bash
# Override the public jarvis persona with your personal version
mkdir -p fragments-local/persona
cp fragments/persona/jarvis.md fragments-local/persona/jarvis.md
# Edit it as you like
bun run distribute --apply
```

Each rendered fragment is tagged with `(local)` or `(repo)` so you can see at a glance which version your agent is reading.

---

## Coexistence with gentle-ai

The two write to the same files (e.g. `~/.claude/CLAUDE.md`) but in **separate namespaces**:

```md
<!-- gentle-ai-overlay:gentlesmith -->
... your forged content ...
<!-- /gentle-ai-overlay:gentlesmith -->

<!-- gentle-ai:persona -->
... gentle-ai's gentleman/neutral persona ...
<!-- /gentle-ai:persona -->

<!-- gentle-ai:sdd -->
... gentle-ai's SDD orchestrator ...
<!-- /gentle-ai:sdd -->
```

`gentle-ai sync` is idempotent and namespace-aware — it doesn't touch our block. We don't touch theirs.

If you're starting from gentle-ai's default Gentleman persona and want to replace it with your own, run:

```bash
gentle-ai uninstall --agent claude-code --component persona --yes
```

Then apply gentlesmith. Or use `--persona custom` when installing gentle-ai (skips the persona inject from the start).

---

## Profiles included

| Profile | What it composes |
|---|---|
| `jarvis` | Example "full stack" persona — identity + Karpathy thinking guidelines + safety/workflow/commits/tools rules + system/toolchain/deployment env |
| `surgical` | Minimal — rules only, no persona, no env |

These are **examples**. The expectation is that you write your own (or fork mine and edit). New community-contributed profiles are welcome via PR.

---

## Targets included

| Agent | Config file | Target file |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `targets/claude.yaml` |
| Antigravity / Gemini CLI | `~/.gemini/GEMINI.md` | `targets/antigravity.yaml` |
| Codex | `~/.codex/agents.md` | `targets/codex.yaml` |

To add another agent, drop a `targets/<name>.yaml`:

```yaml
agent: myagent
profile: jarvis
destination: ~/.myagent/AGENTS.md
mode: prepend
```

---

## Modes

| Mode | Behavior |
|---|---|
| `prepend` | Block goes at the top. Agent reads our content first; everything below is preserved. |
| `managed-block` | Block appended/replaced at the end. Existing content above stays untouched. |

Using gentle-ai → `prepend` recommended (your overlay reads first).
Standalone → either works.

---

## Roadmap

- [x] Fragment composition + distribute (v0.1)
- [x] `prepend` and `managed-block` modes with namespace-aware coexistence
- [x] Cross-platform (macOS / Linux / Windows)
- [ ] `init` wizard — interactive entrypoint that interviews you and writes fragments
- [ ] `add` command — add a bundled preset on top of your config (e.g. `gentlesmith add critical-judge`)
- [ ] Skill levels 2–4 (in-block references, manifest, ambient)
- [ ] Discovery flow for `~/.secrets.agents` and `~/.zshrc.agents` (env detection from the user's environment)
- [ ] More targets (OpenCode, Cursor, Windsurf, Kiro, Kimi, Qwen)
- [ ] SOTA research on agent configuration architectures (consolidate or innovate; no point reinventing)
- [ ] Formal PR to gentle-ai documenting the `gentle-ai-overlay:*` namespace contract — once we have empirical traction
- [ ] (Eventually) hosted gallery of community profiles / sub-agent presets

---

## Status

Alpha. Built originally as an internal layer for one developer (`agents-system`), now generalized. Expect the schema and CLI surface to evolve. The marker namespace (`gentle-ai-overlay:gentlesmith`) is stable.

---

## License

MIT
