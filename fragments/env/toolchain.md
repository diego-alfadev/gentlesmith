# Toolchain

## Node / JS

- **Version manager**: `fnm` — auto-switches on `cd` if `.nvmrc` or `.node-version` is present.
- **Runtime + package manager**: Bun (`~/.bun/`). Commands: `bun install`, `bun run`, `bun test`, `bunx`.

## Python

- **Package manager**: `uv` — replaces pip, venv, poetry, and pyenv for most workflows.
- Commands: `uv add`, `uv venv`, `uv run`, `uv python`.
- If a project has `pyproject.toml` or `uv.lock`, always use `uv`.

## Containers

- **macOS**: OrbStack (replaces Docker Desktop). Standard `docker` commands work as-is. Init loaded from `~/.zprofile`.
- **Windows**: Docker Desktop or Rancher Desktop. Standard `docker` commands work as-is.
- **Linux**: Native Docker or Podman.

## Git

- Conventional commits only (see `rules/commits`).
