---
"@speekl/tasks": minor
---

Overviews now label a parent with how many of its open descendants wait on a person and how many are blocked (`open 2/7 · active · 1 waiting · 2 blocked`), so `tree --top` and `list --top` no longer hide a leaf's wait inside an epic; the JSON is unchanged.
