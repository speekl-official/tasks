---
"@speekl/tasks": patch
---

The SessionStart hook prints `mine` trimmed to the keys the entry decision reads (`--fields id,title,yours,situation,liveness,effective_priority`), and its note says that the entry's `mine` is done; the skill and the protocol run `mine` once, the hook's output being the step where the hooks are installed, so a session that starts with a dozen tasks reads a few hundred tokens instead of several thousand on every start, resume, clear and compaction. Existing installs take the new hook with `tasks hooks install --force`.
