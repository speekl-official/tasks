---
"@speekl/tasks": minor
---

Task objects carry `yours`, how the task is the calling actor's: `this-session` (a claim of this session, or one without a session when the caller has none), `orphaned` (the actor's claim whose session is gone), `elsewhere` (the actor's claim in another live session, or of unknown liveness), `inbox` (an open task assigned to the actor and not claimed by them), else `null`. `mine` is the tasks whose `yours` is not `null`, in that order; every reporting command carries the field, so `ready --json` marks the actor's inbox and `list --working --json` the actor's own orphans without a second command.
