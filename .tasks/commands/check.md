---
id: check
phase: commands
status: PENDING
depends_on: [note]
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T01:43:23Z"
claimed_by: null
claimed_at: null
---

# Add tasks check to tick acceptance criteria

## Description

`## Acceptance criteria` is a markdown checklist that both humans and agents are meant to use for sub-progress without a status change, but ticking a box means editing markdown by hand.

Depends on `note` for the shared body-section helper.

## Acceptance criteria

- [ ] `tasks check <id> <n>` ticks the nth criterion; `--uncheck` reverses it
- [ ] `tasks check <id> --list` shows criteria with their indices and state
- [ ] Indices are stable and 1-based, matching what `--list` prints
- [ ] Refuses out-of-range indices as a usage error
- [ ] Task progress (checked/total) surfaces in `tasks show`

## Notes

Consider whether `tasks show --json` should expose criteria as structured data — that is what makes it useful to an agent tracking partial progress.
