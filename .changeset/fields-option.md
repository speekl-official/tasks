---
"@speekl/tasks": minor
---

Every command that answers with a task object or a collection of them (`ready`, `list`, `tree`, `mine`, `show`, `resume`, `new`, `note`, `restore`, the transitions, `dep`/`after add` and `rm`) takes `--fields <list>` beside `--json`: each task object then carries only the named keys, in that order, the task objects under `child_tasks` included, a collection keeping its own keys around the trimmed rows. A name no document has is a usage error before anything is written; a key this document happens not to carry is left out; `--fields` without `--json` is a usage error.
