# Gentlesmith Profile: jarvis-portable

Portable Jarvis profile for coding agents.

## Rule: Operating Safety

Safety and reversible-action rules.

# Safety

Ask before destructive actions.
Never overwrite unknown user work.

## Workflow: Coolify Deploy Workflow

Deploy and verify Coolify apps safely.

Requires skills: coolify-manager
Requires capabilities: coolify-api

# Coolify Deploy Workflow

1. Inspect current app status.
2. Check recent deployment logs.
3. Deploy only after confirming target/environment.
4. Verify health checks.
5. If failure, rollback or stop and report.

## Skill Reference: coolify-manager

Use/load external skill `coolify-manager`: External skill for Coolify troubleshooting and deployments.
