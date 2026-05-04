# Engram Persistent Memory

Protocol for Engram MCP. MANDATORY and ALWAYS ACTIVE.

## Proactive Save (do NOT wait to be asked)

Call `mem_save` IMMEDIATELY after: architecture/design decisions, conventions established, workflow changes, tool/library choices, bug fixes (include root cause), non-obvious discoveries or gotchas, patterns established, user preferences learned, significant config changes.

Self-check after EVERY task: "Did I make a decision, fix a bug, or learn something? → `mem_save` NOW."

Format: **title** (verb + what, searchable), **type** (bugfix | decision | architecture | discovery | pattern | config | preference), **content** (What / Why / Where / Learned). Use `topic_key` for evolving topics (same key = upsert). Different topics MUST NOT overwrite each other.

## Search Memory

On "remember", "recall", "what did we do", "qué hicimos", or references to past work — also PROACTIVELY when starting related work or when user mentions a topic with no context:

1. `mem_context` (recent history, fast)
2. `mem_search` with keywords if not found
3. `mem_get_observation` for full untruncated content

## Session Close (mandatory before "done" / "listo")

Call `mem_session_summary` with: Goal, Instructions (preferences discovered), Discoveries, Accomplished, Next Steps, Relevant Files. NOT optional — next session starts blind without it.

## After Compaction

1. `mem_session_summary` with the compacted summary content (preserves what was done)
2. `mem_context` to recover additional context
3. Only THEN continue working
