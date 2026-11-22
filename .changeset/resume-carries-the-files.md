---
"@speekl/tasks": patch
---

The agent protocol and the skill read `task.md` and `state.md` through `resume --json`, which carries both (`body`, `state`) with the ancestors, the children, the documentation locations and the last log entry, and open only `design.md`, `plan.md` and the ancestors' files afterwards, so entry reads each file once; the skill asks for what the step reads with `--fields id,title,situation,path,ancestors,child_tasks,workspace,docs,state,last_entry,body`, which trims each child of an epic to five keys.
