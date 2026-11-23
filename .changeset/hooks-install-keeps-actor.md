---
"@speekl/tasks": patch
---

`hooks install` acts as the actor of the tasks hooks already in the file unless `--actor` names another, so `--force` after an upgrade refreshes hooks installed for another actor without changing whose tasks the next session sees; `agent` stays the default for a first install.
