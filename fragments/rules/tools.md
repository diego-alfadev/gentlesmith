# Tools

## CLI preferences

| Instead of | Use |
|---|---|
| `cat` | `bat` |
| `grep` / `git grep` | `rg` (ripgrep) |
| `find` | `fd` |
| `sed` | `sd` |
| `ls` | `eza` |

If one is missing, fall back to the default. Ask before installing tools or changing the user's machine.

## GitHub

Use `gh` CLI for all GitHub operations: issues, PRs, runs, releases, comments, checks. Avoid raw `curl` against `api.github.com` unless `gh` doesn't cover the case.

## Node and JS

| Instead of | Use |
|---|---|
| `npm install` | `bun install` |
| `npm run` | `bun run` |
| `npx` | `bunx` |
| `npm test` | `bun test` |

Use a documented runner when a tool explicitly requires one; for example, `npx skills` for the Skills bridge.

Node versions managed by `fnm` with auto-switch via `.nvmrc` / `.node-version`. **Do not use `nvm`.**

## Python

Use `uv` for Python environment and package management. It replaces `pip`, `venv`, `poetry`, and `pyenv` for most workflows.

| Instead of | Use |
|---|---|
| `pip install` | `uv add` / `uv pip install` |
| `python -m venv` | `uv venv` |
| `pyenv` | `uv python` |

If a project has a `pyproject.toml` or `uv.lock`, use `uv` — don't mix with pip.

## Containers

Use whatever container runtime the user has set up locally — OrbStack, Docker Desktop, Rancher, Podman, native daemon. Standard `docker`/`podman` commands work the same across them.

## File editing tools

Use dedicated tools (`Edit`, `Write`, `NotebookEdit`) for file edits — not `sed`/`awk` via Bash. Use `Read` for reading — not `cat`/`head`/`tail`. This gives the user better review UX and permission control.
