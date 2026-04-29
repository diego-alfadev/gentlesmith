# Environment Files

> This fragment defines a **convention**, not a hard requirement. Adopt it if you want a clean separation between agent-readable and personal-only env files. Otherwise, remove this fragment from your profile.

Three-tier separation: `~/.secrets.agents`, `~/.zshrc.agents`, `~/.secrets`.

## `~/.secrets.agents` — shared agent context

Constants, tokens, and project metadata that agents need to operate. Readable and expandable by agents as part of continuous improvement.

```bash
# ~/.secrets.agents — examples (bash/zsh syntax)
export DEPLOY_PROJECT_myproject="abc123-uuid"
export DEPLOY_APP_myproject_api="def456-uuid"
export SOME_SERVICE_API_KEY="..."
```

**Windows note:** PowerShell syntax in a `$PROFILE`-loaded file works equally — agents can parse `export KEY=VALUE` lines cross-platform.

**Agents may add entries here** when they detect a recurring need (re-deriving an ID, re-asking for a constant, constructing the same command repeatedly). Always propose before writing; never write silently.

## `~/.zshrc.agents` / shell profile — shared agent logic

Shell functions, aliases, and mini-CLIs that agents can use and expand. Same purpose as `.secrets.agents` but for executable logic rather than values.

```bash
# ~/.zshrc.agents — examples (bash/zsh)
deploy-status() { curl -s "$DEPLOY_URL/api/v1/applications/$1" -H "Authorization: Bearer $DEPLOY_TOKEN"; }
alias k="kubectl"
```

**Windows note:** PowerShell equivalents go in `$PROFILE` or a file it sources. Agents can read and adapt.

**Agents may add entries here** when they detect a friction pattern that a reusable function or alias would eliminate. Always propose before writing.

## `~/.secrets` — private user credentials

Sensitive credentials and tokens for personal sessions only. Not intended for agent use.

> **Convention:** Agents operate on `.secrets.agents` and shell-profile equivalents. They do not read or use values from `~/.secrets` directly. The boundary is enforced by instruction, not OS-level isolation.

## Sourcing (macOS/Linux)

```zsh
source ~/.secrets.agents   # agent-accessible constants
source ~/.zshrc.agents     # agent-accessible logic
source ~/.secrets          # private credentials (user sessions only, by convention)
```

Windows: load these via your PowerShell `$PROFILE` or set vars system-wide.

## Never commit any of these files

`.secrets`, `.secrets.agents`, and shell profile equivalents are local-only. Never committed to any repo.
