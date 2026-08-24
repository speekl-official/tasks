---
id: index-staleness
phase: integrity
status: DONE
depends_on: []
created: "2026-08-22T01:43:17Z"
updated: "2026-08-22T21:59:00Z"
claimed_by: null
claimed_at: null
---

# Report a stale _index.md in tasks validate

## Description

`_index.md` regenerates only on explicit `tasks reindex`, which is deliberate: no read command consumes it, so staleness can never mislead an agent. But it is committed to git, so in practice it is stale most of the time and reviewers see a misleading file in diffs.

`tasks validate` should detect that and report it as a warning.

## Acceptance criteria

- [ ] `tasks validate` compares `_index.md` against freshly rendered output
- [ ] Reports a warning (not an error) when they differ — staleness is not corruption
- [ ] `tasks validate --fix` regenerates it
- [ ] No finding when `_index.md` does not exist at all, which is a valid state

## Notes

Keep it a warning. Promoting it to an error would make CI fail on a file that is explicitly not a source of truth, and would undercut the reason regeneration is explicit.
