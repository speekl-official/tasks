---
id: edit
phase: commands
status: PENDING
depends_on: []
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T01:43:16Z"
claimed_by: null
claimed_at: null
---

# Add tasks edit to open a task in $EDITOR

## Description

Editing a task body means locating its file by hand. `tasks edit <id>` should resolve the id and open the file in `$EDITOR`, keeping the id-to-path mapping an implementation detail.

## Acceptance criteria

- [ ] `tasks edit <id>` opens the resolved file in `$EDITOR` (falling back to `$VISUAL`)
- [ ] Clear error when neither is set, naming the file path so the user can open it manually
- [ ] `--print-path` prints the path instead of opening, for scripting
- [ ] Frontmatter is validated after the editor exits, warning on damage rather than failing silently

## Notes

Do not hold the task lock across an interactive editor session — it would trip the 10s staleness threshold and be reclaimed mid-edit.
