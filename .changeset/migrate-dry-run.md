---
"@speekl/tasks": minor
---

`migrate --dry-run` now performs every check and reports what the migration would do, the refusals included, without writing anything, not even the tree's lock; the JSON carries `dry_run: true`. From a v2 tracker migrating a listed project the preview includes the references other trees hold into it; from the v1 tree itself it says they are not previewed.
