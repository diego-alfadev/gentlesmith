# Environment Files

Three-tier separation of environment files. Location: `~/.secrets.agents`, `~/.zshrc.agents`, `~/.secrets`.

## `~/.secrets.agents` — shared agent context

Constants, tokens, and project metadata that agents need to operate. Readable and expandable by agents as part of continuous improvement.

```bash
# ~/.secrets.agents — examples (bash/zsh)
export COOLIFY_PROJECT_recredit="abc123-uuid"
export COOLIFY_APP_recredit_api="def456-uuid"
export SOME_SERVICE_API_KEY="..."
```

**Windows note:** Use PowerShell syntax in a `$PROFILE`-loaded file, or keep bash syntax in the same `~/.secrets.agents` file — agents can read the values either way.

**Agents can and should add entries here** when they detect a recurring need (re-deriving an ID, re-asking for a constant, constructing the same command repeatedly). Always propose before writing; never write silently.

## `~/.zshrc.agents` / shell profile — shared agent logic

Shell functions, aliases, and mini-CLIs that agents can use and expand. Same purpose as `.secrets.agents` but for executable logic rather than values.

```bash
# ~/.zshrc.agents — examples (bash/zsh)
coolify-app() { curl -s "$COOLIFY_URL/api/v1/applications/$1" -H "Authorization: Bearer $COOLIFY_TOKEN"; }
alias k="kubectl"
```

**Windows note:** PowerShell equivalents go in `$PROFILE` or a file it sources. Agents can read and adapt.

**Agents can and should add entries here** when they detect a friction pattern that a reusable function or alias would eliminate. Always propose before writing.

## `~/.secrets` — private user credentials

Sensitive credentials and tokens for the user's personal sessions only. Not intended for agent use.

> **Convention**: Agents operate on `.secrets.agents` and shell profile equivalents. They do not read or use values from `~/.secrets` directly. This boundary is currently enforced by instruction, not OS-level isolation. A hard technical boundary (agent-specific launch environment) is future work.

## Sourcing (macOS/Linux)

```zsh
source ~/.secrets.agents   # agent-accessible constants — loaded for everyone
source ~/.zshrc.agents     # agent-accessible logic    — loaded for everyone
source ~/.secrets          # private credentials       — user sessions only (by convention)
```

Windows users: ensure these files are loaded via your PowerShell profile (`$PROFILE`) or set env vars system-wide.

All three are loaded in user terminals. Agent terminals inherit the parent environment — they technically have access to all three, but are instructed to use only the `.agents` files.

## Never commit any of these files

`.secrets`, `.secrets.agents`, and shell profile equivalents are never committed to any repo. They live only on the local machine.
