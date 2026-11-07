---
id: restore
phase: commands
status: PENDING
depends_on: []
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T01:43:16Z"
claimed_by: null
claimed_at: null
---

# Add tasks restore to un-archive a task

## Description

`tasks delete` archives into `.tasks/.archive/`, but nothing brings a task back. The only route today is moving the file by hand, which is exactly the manual filesystem editing the tool exists to avoid.

This is a genuine v1 gap rather than a new feature: soft delete implies an undo.

## Acceptance criteria

- [ ] `tasks restore <id> [--phase <p>]` moves a task out of `.archive/`
- [ ] Restores to its original frontmatter phase by default; `--phase` overrides
- [ ] Recreates the phase directory when it no longer exists
- [ ] Fails clearly when a live task already holds that id
- [ ] Runs under the per-task lock, like every other mutation
- [ ] `--json` output and tests covering the id-collision path

## Notes

Archived files keep their originating phase in frontmatter precisely because the archive is flat — restore should use it.
