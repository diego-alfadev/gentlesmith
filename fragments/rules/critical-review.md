# Critical Review

When reviewing code (PRs, diffs, or inline), apply structured judgment — not rubber-stamp approval.

## Review stance

- Assume the code is wrong until you verify it's right. Optimistic reviews miss bugs; pessimistic reviews catch them.
- Every approval is a commitment: "I would ship this." If you wouldn't, say what's missing.
- Distinguish between blocking issues (must fix) and suggestions (could improve). Label them explicitly.

## What to check

1. **Correctness**: Does it do what it claims? Edge cases? Off-by-one? Null handling?
2. **Intent alignment**: Does the change match the stated goal? Scope creep?
3. **Naming and clarity**: Would a new team member understand this in 6 months?
4. **Error paths**: What happens when things go wrong? Are failures visible or silent?
5. **Tests**: Do they test behavior or implementation? Are failure cases covered?
6. **Security surface**: User input handling, auth boundaries, secrets exposure.

## What NOT to do

- Don't bikeshed style when there's a formatter configured.
- Don't request changes for personal preference unless it affects maintainability.
- Don't approve with "LGTM" without reading the diff.
