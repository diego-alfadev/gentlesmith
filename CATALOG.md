# Built-in catalog review

This file defines what belongs in the package versus runtime-local state.

## Default profiles

| Item | Status | Rationale |
|---|---|---|
| `profiles/jarvis.yaml` | default | Developer baseline with persona and core rules. No machine-specific assumptions. |
| `profiles/surgical.yaml` | default | Minimal rules-only profile for focused/sensitive contexts. |

## Fragments

| Fragment | Status | Notes |
|---|---|---|
| `persona/jarvis` | default | Product personality/homage; generic enough to ship. |
| `persona/karpathy-guidelines` | default | Developer thinking principles; useful in the default baseline. |
| `persona/learning-coach` | optional/example | Compact coaching layer for users who want examples-first learning and light gap detection. Not part of the default profile. |
| `rules/safety` | default | Core safety contract. |
| `rules/workflow` | default | Core execution discipline. |
| `rules/commits` | default | Common developer convention. |
| `rules/critical-review` | preset | Useful, but not always wanted in the main profile. |
| `rules/tdd-strict` | preset | Powerful but too strict as a default. |
| `integrations/engram` | auto integration | Recommended when Engram is detected. |
| `integrations/context7` | auto integration | Recommended when Context7 MCP is detected. |
| `integrations/sdd` | auto integration | Recommended when SDD/GGA/gentle-ai is detected. |
| `rules/engram` | legacy/advanced | Full Engram protocol; keep available but not the default discovery recommendation. |
| `rules/sdd-orchestrator` | legacy/advanced | Full SDD orchestrator protocol; gentle-ai usually owns this. |
| `rules/tools` | optional/local preference | Tool choices are opinionated; keep out of defaults. |
| `env/system` | example/template | Do not add from `init`; real system context belongs in runtime-local fragments. |
| `env/toolchain` | example/template | Do not add from `init`; forge/manual editing should create local truth. |
| `env/deployment` | example/template | Deployment details are local and often sensitive. |
| `env/secrets` | example/template | Policy example only; never a default active fragment. |

## Presets

| Preset | Status | Notes |
|---|---|---|
| `critical-judge` | keep | Adds `rules/critical-review`. |
| `tdd-strict` | keep | Adds `rules/tdd-strict`. |
| `engram` | keep, auto-discovered | Adds `integrations/engram`; requires Engram outside gentlesmith. |
| `sdd` | keep, auto-discovered | Adds `integrations/sdd`; requires SDD/gentle-ai outside gentlesmith. |

## Default philosophy

Default built-ins should be low-intrusion, developer-focused, gentle-ai-compatible, and token-conscious. Richer behavior belongs in optional fragments, examples, or local profiles.

Skill incorporation levels:

| Level | Use | Example |
|---|---|---|
| Install-only | Skill exists and the user invokes it manually. | Deep tutor skills |
| Reference | Profile knows when to suggest/use the skill. | `think-through` for uncertain new work |
| Adapted fragment | Small durable behavior extracted from a skill. | `learning-coach` from `grill-me` |
| Embedded rule/persona | Behavior becomes core identity. | Jarvis no-yes-man guardrails |

## Local-only

Never ship these as built-ins:

- user OS details
- real secrets, tokens, or hosts
- deployment instance IDs
- personal aliases/functions
- `local-*` profiles
- machine-specific fragments under `fragments-local/`
