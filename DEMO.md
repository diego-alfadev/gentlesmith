# Gentlesmith demo

Short demo script for showing Gentlesmith to a teammate or gentle-ai maintainer.

Goal: demonstrate that Gentlesmith safely drafts, reviews, exports, and switches agent profiles without replacing gentle-ai.

## 0. Mental model

```text
gentle-ai     = installs/configures the agent ecosystem
gentlesmith   = composes and switches user profiles
OpenCode      = can select Gentlesmith profiles as agents
```

Golden flow:

```bash
gentlesmith forge debugger
gentlesmith export --profile debugger
gentlesmith apply debugger
gentlesmith apply debugger --apply
```

`apply` chooses a profile. `sync` renders whatever profiles are already bound to targets.

## 1. Safe clean start

Use this when the machine may have an old pre-release runtime:

```bash
[ -d ~/.gentlesmith ] && mv ~/.gentlesmith ~/.gentlesmith.backup.$(date +%Y%m%d-%H%M%S)
```

This does not delete anything. It moves the old runtime aside so the current forge flow can bootstrap cleanly.

If the old runtime had useful personal fragments or env notes, keep the backup until after reviewing the new profile.

## 2. Install the beta

```bash
bun add -g gentlesmith@beta
# or
pnpm add -g gentlesmith@beta
gentlesmith help
```

Development from a local checkout remains possible with `bun link`, but the demo should use the published package.

## 3. Forge a profile draft

For the first demo, create a reviewable debugger draft from the Jarvis baseline:

```bash
gentlesmith forge debugger
```

This writes a handoff bundle under:

```text
~/.gentlesmith/forges/<timestamp-debugger>/
├── handoff.md
├── context.json
├── README.md
└── sources/
```

Give `handoff.md` to the active coding agent. The agent does not need to know the Gentlesmith repo: the bundle explains what to write under `~/.gentlesmith`.

For a machine-specific profile, tell the agent:

```text
Use the Gentlesmith forge bundle to create or refine ~/.gentlesmith/profiles/debugger.yaml.
Keep env/toolchain assumptions local. Prefer compact fragments. Do not sync --apply automatically.
```

## 4. Review from the cockpit

```bash
gentlesmith browse
```

Demo the natural actions:

- `Forge profile draft`
- `Review latest bundle`
- `Export / review profile`
- `Preview / apply profile switch`

The point is not the final TUI polish yet. The point is the product shape: profiles are created, reviewed, exported, and activated from one workbench.

## 5. Preview before applying

```bash
gentlesmith apply debugger
```

Expected behavior:

- previews switching enabled targets to `debugger`;
- writes review previews under `~/.gentlesmith/.last-rendered`;
- does **not** write final agent files without `--apply`.

Then write it:

```bash
gentlesmith apply debugger --apply
```

Switch back:

```bash
gentlesmith apply jarvis --apply
```

## 6. OpenCode behavior

If OpenCode is installed, Gentlesmith syncs local profiles as selectable primary agents:

```text
agent.gentlesmith-jarvis
agent.gentlesmith-debugger
```

`apply debugger --apply` sets:

```json
{
  "default_agent": "gentlesmith-debugger"
}
```

Important boundary:

- `sync` preserves non-Gentlesmith `default_agent` values such as `gentle-orchestrator`;
- `apply` intentionally switches the active OpenCode default;
- Gentlesmith only owns `agent.gentlesmith-*` keys.

## 7. Export for review or sharing

```bash
gentlesmith export --profile debugger
```

Exports are catalogable artifacts. They can represent a local profile, a sub-agent profile, a framework agent profile, or a future marketplace entry.

Look for:

```text
~/.gentlesmith/exports/<timestamp-debugger>/
├── catalog.json
├── profile.yaml
├── profile.json
├── source-fragments/
├── summary.md
└── CHANGELOG.md
```

Rendered outputs and diffs appear only when installed targets currently bind to that profile.

## 8. What to show in 10 minutes

1. `gentlesmith forge debugger`
2. Open the generated `handoff.md`
3. Explain that the agent can use the bundle without repo context
4. `gentlesmith export --profile debugger`
5. `gentlesmith apply debugger` as dry-run
6. `gentlesmith apply debugger --apply`
7. Show OpenCode `agent.gentlesmith-*` entries if present
8. Switch back with `gentlesmith apply jarvis --apply`

## 9. Troubleshooting

Check which binary is running:

```bash
which gentlesmith
gentlesmith help
```

Refresh the published beta install:

```bash
bun add -g gentlesmith@beta
which gentlesmith
gentlesmith help
```

If an old runtime pollutes the demo, back it up:

```bash
[ -d ~/.gentlesmith ] && mv ~/.gentlesmith ~/.gentlesmith.backup.$(date +%Y%m%d-%H%M%S)
gentlesmith forge
```

Do not delete the backup until personal fragments/env notes have been reviewed.

## 10. What Gentlesmith is not yet

- Not a replacement for gentle-ai.
- Not a skill builder.
- Not a hidden model runtime.
- Not yet a direct gentle-ai bridge/TUI transport.

For now, the handoff bundle is the bridge: explicit, reviewable, and agent-agnostic.
