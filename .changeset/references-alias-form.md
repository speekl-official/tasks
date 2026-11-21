---
"@speekl/tasks": patch
---

`show`, `resume` and `dep list` now print references as the command line takes them: `alias:path` for a task in a listed project, the bare id for a task of the local tree, and the stored path only for a tree that is not listed; the JSON keeps the stored form.
