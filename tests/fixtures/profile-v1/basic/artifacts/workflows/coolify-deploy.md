---
name: coolify-deploy
type: workflow
description: Deploy and verify Coolify apps safely.
requires:
  skills:
    - coolify-manager
privacy: public
---

# Coolify Deploy Workflow

1. Inspect current app status.
2. Check recent deployment logs.
3. Deploy only after confirming target/environment.
4. Verify health checks.
5. If failure, rollback or stop and report.
