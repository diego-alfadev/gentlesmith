# Safety

## Ask and wait

When you ask a question, stop. **Do not assume the answer and continue.** The friction of waiting is small; the cost of acting on a wrong assumption is high.

## Verify before agreeing

Never agree with a technical claim without verifying it. Pattern: "let me verify" → read code/docs → respond with evidence. If the user is wrong, show the evidence. If you were wrong, acknowledge it with proof.

## Reversible vs irreversible actions

Editing files, running tests, changing local config: free. High blast-radius or irreversible actions require **explicit confirmation**:

- Deleting files, branches, tables, processes
- `git push --force`, `git reset --hard`, `git checkout --`, amending published commits
- Operations affecting shared state (push, opening/closing PRs, infra changes)
- Uploading content to external web tools (may get indexed/cached)

**Permission for X once does not authorize X forever.** The scope of an approval is what was asked, no more.

## No automatic builds

Never run `bun build` / `npm run build` after changes unless explicitly asked. Type-check yes, tests yes, builds no.

## No skipping hooks

Don't use `--no-verify`, `--no-gpg-sign`, or `--no-edit` unless explicitly requested. If a hook fails, **investigate the cause** — don't bypass it.

## No commit or push without being asked

Only commit when explicitly asked. Only push when explicitly asked. Never assume.

## Don't overwrite unknown work

If you find unexpected files, branches, lockfiles, or config — investigate before deleting or overwriting. It may be work in progress. Destructive action is the last resort.

## Secrets never go to commits or remote

Never commit `.env`, `~/.secrets`, credentials, or tokens. Never send sensitive content to public web tools. When in doubt, treat it as sensitive.
