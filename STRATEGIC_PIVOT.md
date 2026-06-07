# Strategic Pivot V2: From "Text Manager" to "Harness Manager"

This document captures strategic product feedback. It is **not** the operative implementation roadmap; `ROADMAP.md` remains the execution source of truth.

Use this file to keep the commercial and UX direction visible while avoiding roadmap drift.

---

## 1. Commercial Positioning

**Problem:** Users can mentally attach Gentlesmith too strongly to `gentle-ai`, reading it as a plugin instead of neutral infrastructure.

**Direction:** Present Gentlesmith as a neutral harness/profile management layer for agentic development.

- Possible future names: `Harnessmith`, `Agentsmith`, or another neutral brand.
- Do not rebrand before product-market signal. Naming cleanup is strategic, not a current implementation blocker.
- Long-term commercial path: open-source standard for local power users first, then team/enterprise policy sync later.

## 2. Multi-agent, Multi-profile Reality

Gentlesmith supports different profiles applied to different agents at the same time: for example, OpenCode can use a `TDD` profile while Claude Code uses a `Reviewer` profile.

Implications:

- A single global editor status indicator is misleading unless it can show per-agent state.
- A CLI/TUI `gentlesmith status` command is the minimal reliable UX primitive.
- Core adapters stay focused on the current frontier: Claude Code, Codex, Antigravity, OpenCode, Pi, and gentle-ai.
- Additional adapters should be added only when a real user or market signal justifies them.

## 3. Harness Surfaces

Gentlesmith should not stop at personas and markdown. Profiles need to represent the agent harness:

- Behavior: personas, rules, workflows, prompts, context, and skills.
- Capabilities: MCP servers, tools, commands, hooks, memory providers, and agent integrations.
- Environment contract: env vars, secret references, local paths, privacy, portability, and target support.

Strategic sequence:

1. Model capabilities as first-class resources.
2. Detect and warn about capability gaps.
3. Render/write adapter-specific config only where the mapping is safe.
4. Automate broader setup after the model can represent what it changes.

## 4. Time-to-value and Scan Path

The product should optimize for time-to-value under 5 minutes:

- Scan existing agent configs and AGENTS.md-style files.
- Explain what was discovered.
- Create a reviewable modular profile.
- Show unresolved gaps and private/local assumptions.
- Preview before applying.

This should evolve from the existing discovery snapshot and `forge --from-agents` work rather than becoming a competing onboarding system.

## 5. Secrets and Environment Safety

Gentlesmith must never store secret values in profile artifacts.

Allowed:

- `${env:SECRET_KEY}` references.
- Local/private profile metadata.
- Warnings for missing env vars.

Rejected:

- Plaintext API keys in public/exportable bundles.
- Silent propagation of local machine paths into public profiles.
- Agent-triggered mutations without audit or approval.

## 6. Gentlesmith as MCP Server

This is a strong future direction, but not a current foundation task.

Good first MCP tools:

- `read_active_profiles`
- `list_profile_resources`
- `explain_profile_gaps`

Later write tools:

- `add_rule`
- `update_workflow`
- `add_capability_to_profile`

Write tools require an audit log, explicit user confirmation, and safe merge semantics. The MCP server must not become a raw filesystem editor.

## 7. Execution Guardrail

Do not replace the current roadmap with this document.

Integrate now:

- `gentlesmith status`.
- Capability resources in Profile v1.
- Time-to-value scan path.
- Secret-reference rules.

Defer:

- Full "scan everything" automation.
- Gentlesmith MCP server write tools.
- Rebranding.
- Enterprise sync and registry/community marketplace.
