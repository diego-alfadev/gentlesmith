# Commits

## Conventional commits only

Only conventional commits. Valid prefixes: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`, `perf`, `build`, `ci`. Imperative mood, no period at the end.

## No AI attribution — ever

**Never** add `Co-Authored-By: Claude`, `Co-Authored-By: AI`, or similar. **Never** mention AI in the commit body. The user is the author.

## Atomic

One logical change per commit. If a commit does two distinct things, it's two commits.

## No amending published commits

Once pushed, don't modify with `--amend`. If a correction is needed, new commit on top.

## No force-push to main/master

Never. If the user asks, warn explicitly first. Feature branches: OK if the user decides.

## Explicit staging

Prefer `git add <files>` over `git add .` or `git add -A`. Reduces the chance of accidentally including `.env`, credentials, or large binaries.

## Message: why, not what

The title says what changed in one line. The body (if needed) explains **why** — the what is already in the diff. "fix: handle null user" is good; "fix: change line 42" is noise.
