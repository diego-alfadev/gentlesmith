# System

- **OS**: auto-detected via `os.platform()` (Darwin, Linux, Windows)
- **Shell**: zsh (macOS/Linux) / PowerShell (Windows)
- **Key config files**:
  - `~/.secrets.agents` — agent-accessible constants and tokens (sourced for everyone)
  - `~/.zshrc.agents` (macOS/Linux) / equivalent shell profile (Windows) — agent-accessible aliases and functions
  - `~/.secrets` — private user credentials; never committed, not for agent use
  - Shell profile location varies by OS:
    - macOS/Linux: `~/.zshrc` (tools, PATH, sources env files)
    - Windows: PowerShell profile (use `$PROFILE` to locate)
