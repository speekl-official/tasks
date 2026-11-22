---
"@speekl/tasks": patch
---

The agent protocol and the skill read `task.md` and `state.md` through `resume`, which carries both in either form, with the gates, the ancestors, the children, the documentation locations and the last log entry, and open only `design.md`, `plan.md` and the ancestors' files afterwards, so entry reads each file once; `--fields` on `resume` trims the children too, so the skill says which keys to keep when trimming.
