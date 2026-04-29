# Deployment — Coolify

- Self-hosted PaaS at `$COOLIFY_URL` (from `~/.secrets.agents`)
- Token: `$COOLIFY_TOKEN` (from `~/.secrets.agents`)
- **Never hardcode** these values. Always use the env var.

## SSH hosts

Define your hosts in `~/.ssh/config` or add them to `~/.zshrc.agents`:

```zsh
# ~/.zshrc.agents — example SSH host
alias prod='ssh user@your-server-ip'
```

Pre-configured hosts for this environment (user-specific, not portable):
- Check `~/.secrets.agents` or `~/.ssh/config` for active hosts
