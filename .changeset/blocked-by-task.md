---
"@speekl/tasks": minor
---

Every `blocked_by` entry, in task objects and in the details of a gate refusal, and every row of `dep list` and `after list` carries `task` beside `ref`: the target as the command line names it (`api:webhooks/delivery-log` for a listed project, `epic/api` for the local tree), or `null` when no alias names its tree, so an agent reading `--json` no longer maps the stored `../ledger-api:…` form to an alias by itself.
