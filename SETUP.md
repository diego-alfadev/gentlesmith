# SETUP — Portable gentlesmith

Cross-platform setup guide for **macOS / Linux / Windows**.

## Prerequisites

| Tool | macOS/Linux | Windows |
|------|-------------|---------|
| Bun | `curl -fsSL https://bun.sh/install | bash` | `powershell -c "irm bun.sh/install.ps1 | iex"` |
| Git | `brew install git` / apt/dnf | Download from git-scm.com |
| Node.js (optional) | `fnm install --lts` | `fnm install --lts` (via fnm-windows) |

---

## Step 1 — Install

Preferred once published:

```bash
bun add -g gentlesmith
# or
pnpm add -g gentlesmith
```

Current pre-release repo workflow:

```bash
git clone https://github.com/diego-alfadev/gentlesmith
cd gentlesmith
bun install
bun link
```

## Step 2 — Forge your local profile

```bash
gentlesmith forge
```

`forge` bootstraps `~/.gentlesmith` if needed, discovers gentle-ai/OpenCode/Engram/Context7/skills, and writes a self-contained Workbench bundle for profile refinement.

If you only want deterministic bootstrap:

```bash
gentlesmith init
```

Manual deterministic forge fallback:

```bash
gentlesmith forge --manual
```

## Step 3 — Browse, apply, export

```bash
gentlesmith browse                  # cockpit
gentlesmith apply debugger          # preview switching active profile
gentlesmith apply debugger --apply  # write profile switch
gentlesmith export --profile local-debugger
```

Check previews in `~/.gentlesmith/.last-rendered/` and exports in `~/.gentlesmith/exports/` before applying irreversible changes.

`sync` renders installed targets without choosing a new profile:

```bash
gentlesmith sync              # dry-run current target bindings
gentlesmith sync --apply      # write current target bindings
gentlesmith sync --target codex
```

Advanced target binding remains available:

```bash
gentlesmith target set-profile claude local-yourname
```

## Clean start from an older install

If you used an old pre-release runtime and want a fresh start:

```bash
mv ~/.gentlesmith ~/.gentlesmith.backup.$(date +%Y%m%d-%H%M%S)
gentlesmith forge
```

Keep the backup until you have copied any personal profiles/fragments you still need.

## Optional local env files

Use this only if you want agents to read local constants, aliases, or machine context. These files live in your home directory. **Never commit them.**

### macOS / Linux

```bash
touch ~/.secrets.agents   # agent-accessible constants + tokens
touch ~/.zshrc.agents     # agent-accessible aliases + functions
touch ~/.secrets          # your private creds (not for agents)
```

Add to `~/.zshrc` (or `~/.bashrc`):
```zsh
source ~/.secrets.agents
source ~/.zshrc.agents
# source ~/.secrets   # optional — only in your own terminals
```

### Windows (PowerShell)

```powershell
# Creates the files in your home dir
ni $HOME/.secrets.agents
ni $HOME/.zshrc.agents
ni $HOME/.secrets
```

Add to your PowerShell profile (`notepad $PROFILE`):
```powershell
# Load agent env
if (Test-Path "$HOME/.secrets.agents") { Get-Content "$HOME/.secrets.agents" | ForEach-Object { if ($_ -match '^export\s+(\w+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'), 'Process') } }

# Optional: your private creds
# if (Test-Path "$HOME/.secrets") { ... }
```

## Optional agent-readable constants

Edit `~/.secrets.agents` only for values your agents genuinely need:

```bash
# ~/.secrets.agents — examples, replace with your own values
export DEPLOY_URL="https://deploy.example.com"
export DEPLOY_TOKEN="your-token-here"
export SOME_SERVICE_API_KEY="..."

# SSH hosts as aliases (macOS/Linux)
# alias myserver='ssh user@my-ip'

# Or as env vars
export SSH_HOST_PROD="user@ip"
```

Windows users: same file, same syntax — agents can parse `export KEY=VALUE` lines cross-platform.

## Profiles

Built-in profile templates are in `profiles/`; machine-local profiles live in `~/.gentlesmith/profiles/`:

| Profile | What it includes | Use case |
|---------|-----------------|----------|
| `jarvis` | Jarvis-inspired persona + standard developer rules | Daily driver baseline |
| `surgical` | Minimal rules only, no persona/env/toolchain assumptions | CI, sensitive repos, focused tasks |

To create your own persona for this machine, prefer:

```bash
gentlesmith forge
```

Or edit runtime-home manually:

```bash
mkdir -p ~/.gentlesmith/fragments-local/persona
cp fragments/persona/jarvis.md ~/.gentlesmith/fragments-local/persona/my-persona.md
# Edit it, then reference persona/my-persona from ~/.gentlesmith/profiles/<your-profile>.yaml
```

## Targets

Target templates live in `targets/`; installed machine-local targets live in `~/.gentlesmith/targets/`. Example installed target:

```yaml
agent: claude
profile: jarvis          # or your own profile name
destination: ~/.claude/CLAUDE.md   # macOS/Linux
# destination: C:\Users\You\.claude\CLAUDE.md  # Windows
mode: prepend
```

OpenCode selectable profiles use:

```yaml
agent: opencode
profile: local-yourname
destination: ~/.config/opencode/opencode.json
mode: opencode-agent
```

gentlesmith only writes `agent.gentlesmith-*` keys in OpenCode config.

Windows note: gentlesmith resolves `~` via the user home directory, so `~/.claude/CLAUDE.md` works cross-platform.

If you previously used an older repo-local setup and want to import detected overlays:

```bash
gentlesmith migrate
```

## Verify

Open your agent (Claude Desktop, etc.) and check the system prompt includes your fragments.

---

## Troubleshooting

- **Windows + Bun**: Ensure Bun is in your PATH (`$env:PATH` in PowerShell)
- **Permissions**: `distribute.ts` needs write access to the destination file
- **Secrets not loading**: Agents read `~/.secrets.agents` at runtime — ensure it exists and has valid `export KEY=VALUE` lines
