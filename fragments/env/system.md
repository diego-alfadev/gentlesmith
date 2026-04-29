# System

> Example fragment. Defines the system shape this profile assumes. Adjust to match your machine, or remove this fragment from your profile if you don't want OS hints in your agent's prompt.

- **OS**: auto-detected — Darwin (macOS), Linux, or Windows
- **Shell**: zsh on macOS/Linux, PowerShell on Windows
- **Key config files** (conventions this profile proposes — see `env/secrets`):
  - `~/.secrets.agents` — agent-accessible constants and tokens
  - `~/.zshrc.agents` (macOS/Linux) or shell profile equivalent (Windows) — agent-accessible aliases and functions
  - `~/.secrets` — private user credentials (not for agent use, by convention)
- **Shell profile location**:
  - macOS/Linux: `~/.zshrc` (loads tools, PATH, sources the agent env files)
  - Windows: PowerShell `$PROFILE`
