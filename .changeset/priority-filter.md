---
"@speekl/tasks": minor
---

`list` and `ready` take `--priority <level>`, which keeps the tasks whose effective priority is at least that level (`list --blocked --priority high`: the blocked tasks that are high or urgent, an inherited level counting); on `list` it narrows what the situation filters select instead of joining them, and a level outside `urgent`, `high`, `normal`, `low` is a usage error.
