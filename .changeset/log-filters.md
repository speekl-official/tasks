---
"@speekl/tasks": minor
---

`log --since` takes `--actor <actor>` (one actor's entries) and `--scope <path>` (the entries of a task or group of the local tree and everything beneath it, which keeps the listing to that tree, as a scope keeps an overview; a path that names nothing is exit `3`), the two combining; and `tasks log <task> --since <when>` reads one task's history since a time, `--actor` narrowing it too, where the combination was refused before.
