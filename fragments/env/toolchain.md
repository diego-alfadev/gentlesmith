# Toolchain

> Example fragment. Describes the toolchain this profile assumes. Edit to match yours, or omit from your profile if you don't want toolchain hints in the agent's prompt.

## Node / JS

- Version manager: `fnm` (auto-switches via `.nvmrc` / `.node-version`)
- Runtime + package manager: Bun. Commands: `bun install`, `bun run`, `bun test`, `bunx`.

## Python

- Package manager: `uv` — replaces pip / venv / poetry / pyenv for most workflows.
- Commands: `uv add`, `uv venv`, `uv run`, `uv python`.
- If a project has `pyproject.toml` or `uv.lock`, prefer `uv`.

## Containers

Whatever the user has set up locally:

- macOS: OrbStack or Docker Desktop
- Linux: native Docker / Podman
- Windows: Docker Desktop or Rancher Desktop

Standard `docker`/`podman` commands work across all of them.

## Git

- Conventional commits (see `rules/commits`).
