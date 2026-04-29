# agents-system

> A personal behavior layer for AI coding agents. One source of truth — persona, rules, and environment context — distributed to every agent you use via composition.

**Works with or without [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai).** If you use gentle-ai, this layer adds what it intentionally leaves out: your persona, your rules, your environment.

Cross-platform: macOS · Linux · Windows

---

## What it does

Instead of copy-pasting your persona into every agent config separately, you write it once as composable **fragments** and a script distributes them everywhere:

```
fragments/         ← atomic pieces (one concern each)
  persona/         ← who the agent is + thinking principles
  rules/           ← commits, tools, safety, workflow
  env/             ← your system context (toolchain, deployment, etc.)

profiles/          ← recipes: which fragments, in which order
  jarvis.yaml      ← full profile: persona + rules + env
  surgical.yaml    ← minimal: rules only, no persona, no env

targets/           ← where each profile gets rendered
  claude.yaml      ← → ~/.claude/CLAUDE.md
  antigravity.yaml ← → ~/.gemini/GEMINI.md
  codex.yaml       ← → ~/.codex/agents.md
  ...

bin/distribute.ts  ← renders fragments → managed-block in each target
```

Update a fragment once → run `bun run distribute --apply` → all agents updated.

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/your-org/agents-system
cd agents-system
bun install
```

### 2. Read the setup guide

→ [SETUP.md](SETUP.md) — environment files, cross-platform config, step-by-step.

### 3. Set up dialogically (recommended for first time)

Paste the prompt in [ONBOARDING-PROMPT.md](ONBOARDING-PROMPT.md) into your agent.
It will interview you, write your fragments, and apply your config.

### 4. Or do it manually

```bash
# Edit fragments to match your preferences
nano fragments/persona/jarvis.md

# Dry-run: see what would change
bun run distribute

# Apply to all agents
bun run distribute --apply

# Apply to one agent only
bun run distribute --apply --target claude
```

---

## Supported agents

Any agent that reads a Markdown system prompt file. Pre-configured targets:

| Agent | Config file | Target |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `targets/claude.yaml` |
| Antigravity / Gemini CLI | `~/.gemini/GEMINI.md` | `targets/antigravity.yaml` |
| Codex | `~/.codex/agents.md` | `targets/codex.yaml` |
| OpenCode | `~/.config/opencode/AGENTS.md` | add `targets/opencode.yaml` |
| Kimi Code | `~/.kimi/KIMI.md` | add `targets/kimi.yaml` |
| Any other | wherever it reads Markdown | add a target yaml |

To add a new agent, create `targets/myagent.yaml`:

```yaml
agent: myagent
profile: jarvis       # or surgical, or your own profile
destination: ~/.myagent/AGENTS.md
mode: prepend         # block goes first; existing content stays below
```

Then `bun run distribute --apply --target myagent`.

---

## Profiles

| Profile | Includes | Use case |
|---|---|---|
| `jarvis` | persona + karpathy guidelines + rules + env | Your daily driver |
| `surgical` | commits + tools + safety only | CI, sensitive repos, quick tasks |

Create your own profile by listing any combination of fragments in a new `profiles/mypersona.yaml`.

---

## Modes

| Mode | Behavior |
|---|---|
| `prepend` | Block goes at the top. Agent reads persona before anything else. |
| `managed-block` | Block appended at end. Preserves all existing content above. |

**Using gentle-ai?** Use `prepend`. gentle-ai's SDD, Engram, and MCP content stays below — no conflict.
**Not using gentle-ai?** Either works. `prepend` recommended.

---

## Coexistence with gentle-ai

gentle-ai's `sync` command excludes persona by default. This means:

- gentle-ai manages: SDD orchestrator, Engram protocol, MCP servers, skills, model routing.
- agents-system manages: persona, rules, environment context.

No conflicts. To remove the default Gentleman persona first:

```bash
gentle-ai uninstall --agent claude-code --component persona --yes
```

Then apply agents-system normally.

---

## Fragment reference

| Fragment | What it defines |
|---|---|
| `persona/jarvis` | Identity, mode, teaching approach, tone, closing style |
| `persona/karpathy-guidelines` | Foundations-first, verify over assert, debug mindset |
| `rules/safety` | Ask-then-wait, reversible vs irreversible, no auto-build |
| `rules/workflow` | Push back, alternatives with tradeoffs, no premature abstractions |
| `rules/commits` | Conventional commits, no AI attribution, atomic, explicit staging |
| `rules/tools` | CLI preferences (bat/rg/fd/sd/eza), gh CLI, bun, uv |
| `env/system` | OS, shell, config file locations |
| `env/toolchain` | fnm/Bun, uv/Python, OrbStack/Docker |
| `env/deployment` | Deployment platform, SSH hosts |
| `env/secrets` | Three-tier env file pattern (.secrets.agents / .zshrc.agents / .secrets) |

---

## Roadmap

- [x] Fragment composition + distribute script (v1)
- [x] `prepend` and `managed-block` modes
- [x] Cross-platform (macOS / Linux / Windows)
- [x] Onboarding prompt for dialogic setup
- [ ] Line-by-line diff in dry-run
- [ ] `bin/scaffold.ts` — create env files from templates
- [ ] More pre-configured targets (opencode, kimi, cursor)
- [ ] Upstream contribution to gentle-ai as `gentle-ai overlay sync`

---

## License

MIT
