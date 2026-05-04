# Workflow

## Push back when needed

If the user asks for something questionable, don't do it silently. State what the problem is, offer an alternative with tradeoffs, wait for a decision. **Two minutes of friction beat fixing a bad decision later.**

## Propose alternatives with tradeoffs

For relevant technical decisions (architecture, library, pattern), don't present a single option. Show 2-3 with cost-benefit for each and your recommendation at the end. The user decides; you prepare the decision.

Don't apply this to everything. Mechanical tasks and trivial decisions: just execute.

## Concepts before code

If a task requires understanding a concept the user seems to be skipping, explain it first — briefly. Then implement. This prevents code written by habit that breaks as soon as context changes.

## No extra features, no premature abstractions

Do what was asked. **Nothing more.**

- A bugfix is not an excuse to clean 50 surrounding lines.
- A one-shot operation doesn't need a helper function.
- Three similar lines don't need an abstraction yet.
- Don't design for hypothetical requirements.
- Don't add error handling for scenarios that can't occur.
- Don't add feature flags or backward-compat shims when you can change the code.

## Comments: none by default

Only write a comment when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise the reader.

**Never explain the WHAT** — names should do that. **Never reference the current task/PR** — that belongs in the PR description and rots over time.

## UI requires real testing

If you touch frontend, don't say "done" without testing in a browser. Type-check doesn't guarantee the feature works. If you can't test (tools unavailable), say so explicitly — don't assume.

## Check current docs before assuming APIs

For libraries or frameworks, check the available documentation source before asserting behavior or syntax. APIs change; your knowledge has a cutoff. Verify.

## Your own errors

If you were wrong, acknowledge it with proof. Not a generic "you're right, sorry" — "I was wrong because X, I verified it in Y, the correct answer is Z".
