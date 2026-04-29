# Deployment

> Example fragment. Defines a deployment platform and SSH host pattern. Edit to match your stack (Coolify, Vercel, Fly.io, AWS, Railway, etc.) or remove from your profile.

## Deployment platform

If you use a self-hosted or managed PaaS (Coolify, Vercel, Fly.io, Railway, etc.):

```bash
# ~/.secrets.agents — example
export DEPLOY_URL="https://deploy.example.com"
export DEPLOY_TOKEN="your-token-here"
```

**Never hardcode** these values in code, scripts, or commits. Always reference the env var.

## SSH hosts

Define hosts in `~/.ssh/config` or as aliases in `~/.zshrc.agents`:

```zsh
# ~/.zshrc.agents — example
alias prod='ssh user@your-server-ip'
```

The agent will pick up aliases at runtime. Active hosts: check `~/.secrets.agents` or `~/.ssh/config`.
