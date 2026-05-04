# Roadmap — gentlesmith

Goal: make gentlesmith the forge-first customization layer for gentle-ai and AI coding agents.

## P0 — Forge-first runtime

- [x] Runtime state lives outside the repo in `~/.gentlesmith`.
- [x] `sync` renders installed targets from runtime-local target definitions.
- [x] Local profiles can be bound to targets.
- [x] `forge` exists.
- [x] `forge` auto-bootstraps runtime state when needed.
- [x] `init` is deterministic bootstrap, not a competing onboarding wizard.
- [x] Discovery is internal via `DiscoverySnapshot`.
- [x] README quickstart leads with `gentlesmith forge`.

## P1 — Gentle-ai and OpenCode alignment

- [x] gentle-ai/toolchain discovery runs under the hood.
- [x] Integration fragments exist for Engram, Context7, and SDD.
- [x] OpenCode target can register selectable `agent.gentlesmith-*` profiles.
- [x] Contract states gentlesmith must not touch `gentle-orchestrator` or `sdd-*`.
- [ ] Validate OpenCode selectable profiles in a real OpenCode session.

## P2 — Browse cockpit

- [x] Browse shows discovery snapshot.
- [x] Browse shows installed/global skills.
- [x] Profile workspace opens profile, fragments, and skill roots.
- [ ] Improve spacing/back navigation to match gentle-ai TUI quality.
- [ ] Add first-class target/profile rebinding in Browse instead of relying on advanced CLI.

## P3 — Skills

- [x] Skills are discovery/toggle/reference only.
- [x] Skill builder is out of scope.
- [ ] Confirm skills.sh global storage and CLI behavior before deeper integration.
- [ ] Decide whether skills should be installed by gentlesmith or delegated to gentle-ai when available.

## P4 — Packaging

- [ ] Publish package once CLI/runtime semantics stabilize.
- [ ] Replace local `bun link` docs with `bun add -g gentlesmith` / npm/pnpm equivalents.
- [ ] Add release/update story that does not depend on local repo path.

## P5 — Plugin path

- [ ] Define how gentle-ai should expose gentlesmith in its TUI.
- [ ] Decide whether OpenCode profile registration should eventually be delegated to gentle-ai.

## Later — Profile evaluation

- [ ] Explore `gentlesmith patch` as a self-contained TUI/CLI flow for adapting installed skills or free-form ideas into profile fragments.
- [ ] Explore profile benchmarking: run the same prompts against multiple profiles and compare behavior, friction, and token cost.
