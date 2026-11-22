---
"@speekl/tasks": patch
---

The agent protocol and the skill read `task.md` and `state.md` through `resume`, which carries both in either form, with the gates, the ancestors, the children, the documentation locations and the last log entry, and open only `design.md`, `plan.md` and the ancestors' files afterwards, so entry reads each file once; `--fields` on `resume` trims the children too, so entry reads `resume` whole and the skill names the children's keys a projection must keep; a project's own frontmatter keys, which the task object does not carry, are read from `task.md` when the project's instructions name one.
