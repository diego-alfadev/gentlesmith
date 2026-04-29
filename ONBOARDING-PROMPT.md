# Onboarding Prompt — agents-system

Paste the block below into your agent to kick off your personal setup.
The agent will interview you, fill your fragments, and apply your configuration.

---

```
You are going to help me set up agents-system — a personal behavior layer for AI agents.

First, read these files in the repo to understand the structure:
- README.md
- SETUP.md
- profiles/jarvis.yaml  (the default full profile)
- profiles/surgical.yaml
- One fragment as example: fragments/persona/jarvis.md

Then guide me through a short discovery interview (one topic at a time, max 2 questions per round).
After each answer, confirm what you understood before moving on.

When the interview is done, you will:
1. Write my personalized fragments to the fragments/ directory
2. Create or update targets/<agent>.yaml for each agent I use
3. Run `bun run distribute --dry-run` and show me the summary
4. Ask for confirmation, then run `bun run distribute --apply`

Here are the topics to cover:

--- PERSONA ---
- What tone do you want your agent to have? (e.g. direct/terse, mentor/teaching, Jarvis-style, casual)
- Should the agent push back when you're wrong, or stay deferential?
- Do you want it to explain concepts before writing code, or just execute?
- Preferred language for agent responses? (English, Spanish, other)

--- RULES ---
- Do you use conventional commits? Any other commit conventions?
- Preferred CLI tools? (e.g. bat/rg/fd over cat/grep/find, or standard tools)
- How strict on safety confirmations? (confirm destructive actions, never auto-build, etc.)

--- ENVIRONMENT ---
- OS: macOS, Linux, or Windows?
- Main language/runtime: Node/Bun, Python/uv, Go, other?
- Container tool: OrbStack, Docker Desktop, Rancher, none?
- Do you use any deployment platforms? (Coolify, Vercel, Fly.io, AWS, etc.)
- Any recurring SSH hosts or services I should know about?

--- AGENTS ---
- Which AI coding agents do you use? (Claude Code, Antigravity, Codex, OpenCode, Cursor, etc.)
- Any agent-specific behavior differences? (e.g. one for focused tasks, one for full context)

Start with PERSONA. Ask me the first question now.
```

---

## After setup

Once your agent has applied the configuration, verify it worked:

```bash
# See the block structure
grep -n "agents-system\|fragment:" ~/.claude/CLAUDE.md   # or your agent's config file

# Re-run anytime you update fragments
bun run distribute --apply
```

To add a new agent later: create `targets/<agent>.yaml` and run `distribute --apply --target <agent>`.
