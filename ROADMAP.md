# Roadmap — gentlesmith

Goal: make gentlesmith the forge-first customization layer for gentle-ai and AI coding agents.

## P0 — Forge-first runtime

- [x] Runtime state lives outside the repo in `~/.gentlesmith`.
- [x] `sync` renders installed targets from runtime-local target definitions.
- [x] Local profiles can be bound to targets.
- [x] `apply <profile>` switches enabled targets with dry-run by default.
- [x] Sync/apply detect same-destination target collisions before writing.
- [x] `forge` exists.
- [x] `forge` auto-bootstraps runtime state when needed.
- [x] `forge` writes self-contained Workbench bundles by default.
- [x] `forge` can inherit an env baseline from local profiles or stay env-agnostic for portable profiles.
- [x] `init` is deterministic bootstrap, not a competing onboarding wizard.
- [x] Discovery is internal via `DiscoverySnapshot`.
- [x] README quickstart leads with `gentlesmith forge`.
- [x] Docs clarify multi-profile behavior: targets bind to profiles; profiles can exist without being synced.

## P1 — Gentle-ai and OpenCode alignment

- [x] gentle-ai/toolchain discovery runs under the hood.
- [x] Integration fragments exist for Engram, Context7, and SDD.
- [x] OpenCode sync registers Gentlesmith profiles as selectable primary agents.
- [x] `apply <profile>` sets OpenCode `default_agent` to the selected Gentlesmith profile.
- [x] Contract states gentlesmith must not touch `gentle-orchestrator` or `sdd-*`.
- [ ] Validate OpenCode selectable profiles in a real OpenCode session.

## P2 — Browse cockpit

- [x] Browse shows discovery snapshot.
- [x] Browse shows installed/global skills.
- [x] Profile workspace opens profile, fragments, and skill roots.
- [x] Browse exposes apply/switch and export/review profile actions.
- [ ] Improve spacing/back navigation to match gentle-ai TUI quality.
- [ ] Add first-class target/profile rebinding in Browse instead of relying on advanced CLI.

## P3 — Skills

- [x] Skills are discovery/toggle/reference only.
- [x] Skill builder is out of scope.
- [x] Minimal L1 skill references use compact local `references/<slug>` fragments.
- [x] Third-party skills stay external/upstream, not vendored as built-ins.
- [ ] Confirm skills.sh global storage and CLI behavior before deeper integration.
- [ ] Decide whether skills should be installed by gentlesmith or delegated to gentle-ai when available.

## P4 — Packaging

- [ ] Publish package once CLI/runtime semantics stabilize.
- [ ] Replace local `bun link` docs with `bun add -g gentlesmith` / npm/pnpm equivalents.
- [ ] Add release/update story that does not depend on local repo path.

## P5 — Plugin path

- [x] Forge bundles include bridge-readiness context when gentle-ai is detected.
- [ ] Define how gentle-ai should expose gentlesmith in its TUI.
- [ ] Verify gentle-ai public plugin/bridge contract before implementing transport.
- [ ] Decide whether OpenCode profile registration should eventually be delegated to gentle-ai.

## Later — Profile evaluation

- [x] Add `gentlesmith patch` CLI bundle flow for adapting installed skills or free-form ideas into profile fragments.
- [x] Make `gentlesmith export` produce catalogable profile specs with source fragments and target applicability.
- [ ] Add `gentlesmith patch` to Browse/TUI as a self-contained guided flow.
- [ ] Add local export comparison across two profile specs.
- [ ] Explore profile benchmarking: run the same prompts against multiple profiles and compare behavior, friction, and token cost.
