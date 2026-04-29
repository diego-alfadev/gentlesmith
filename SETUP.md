# SETUP — Portable gentlesmith

Cross-platform setup guide for **macOS / Linux / Windows**.

## Prerequisites

| Tool | macOS/Linux | Windows |
|------|-------------|---------|
| Bun | `curl -fsSL https://bun.sh/install | bash` | `powershell -c "irm bun.sh/install.ps1 | iex"` |
| Git | `brew install git` / apt/dnf | Download from git-scm.com |
| Node.js (optional) | `fnm install --lts` | `fnm install --lts` (via fnm-windows) |

---

## Step 1 — Clone & install

```bash
git clone <this-repo-url> gentlesmith
cd gentlesmith
bun install
```

## Step 2 — Create your local env files

These files live in your home directory. **Never commit them.**

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

## Step 3 — Configure your secrets

Edit `~/.secrets.agents` and add what your agents need:

```bash
# ~/.secrets.agents — examples (use your own values)
export COOLIFY_URL="https://your-coolify-instance.com"
export COOLIFY_TOKEN="your-token-here"
export SOME_API_KEY="..."

# SSH hosts as aliases (macOS/Linux)
# alias myserver='ssh user@my-ip'

# Or as env vars
export SSH_HOST_PROD="user@ip"
```

Windows users: same file, same syntax — agents can parse `export KEY=VALUE` lines cross-platform.

## Step 4 — Choose your profile

Profiles are in `profiles/`:

| Profile | What it includes | Use case |
|---------|-----------------|----------|
| `jarvis` | Full — persona + rules + env context | Your daily driver |
| `surgical` | Minimal — rules only, no persona/env | CI, sensitive repos, focused tasks |

To create your own persona, copy a fragment:
```bash
cp fragments/persona/jarvis.md fragments/persona/my-persona.md
# Edit it, then add it to a new profile in profiles/
```

## Step 5 — Configure targets

Targets map profiles to destination files. Edit `targets/claude.yaml`:

```yaml
agent: claude
profile: jarvis          # or your own profile name
destination: ~/.claude/CLAUDE.md   # macOS/Linux
# destination: C:\Users\You\.claude\CLAUDE.md  # Windows
mode: prepend
```

Windows note: `distribute.ts` converts `~` automatically via `os.homedir()`, so `~/.claude/CLAUDE.md` works on Windows too.

## Step 6 — Dry-run & apply

```bash
bun run distribute              # dry-run — see what would change
bun run distribute --apply      # write changes to target files
```

Check previews in `.last-rendered/` before applying.

## Step 7 — Verify

Open your agent (Claude Desktop, etc.) and check the system prompt includes your fragments.

---

## Custom personas quick-start

To create "Jotaro" (JoJo) or "Wolf of Wall Street" persona:

1. Create `fragments/persona/jotaro.md` with your persona definition
2. Create `profiles/jotaro.yaml`:
   ```yaml
   name: jotaro
   description: JoJo's Bizarre Adventure persona — direct, stoic, references stands.
   include:
     - persona/jotaro
     - rules/safety
     - rules/workflow
     - rules/commits
   ```
3. Create `targets/jotaro-claude.yaml` pointing to your agent's config file
4. Run `bun run distribute --apply --target jotaro-claude`

## Troubleshooting

- **Windows + Bun**: Ensure Bun is in your PATH (`$env:PATH` in PowerShell)
- **Permissions**: `distribute.ts` needs write access to the destination file
- **Secrets not loading**: Agents read `~/.secrets.agents` at runtime — ensure it exists and has valid `export KEY=VALUE` lines
