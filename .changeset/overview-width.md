---
"@speekl/tasks": patch
---

Overviews fit the terminal's width when stdout is a terminal: a row that would wrap has its TITLE cut with an ellipsis, then SITUATION, then LABELS, each down to a floor, while ids, ages and priorities stay whole; piped output and `--json` are never cut. `ready`, `list` and `dep list` now align their columns like `tree` and `mine` (two spaces apart, no leading space). The liveness label of an orphaned claim gives the age of the last heartbeat (`orphaned 3d`) instead of its timestamp, which `show` and `resume` keep.
