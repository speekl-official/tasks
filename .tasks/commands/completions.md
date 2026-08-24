---
id: completions
phase: commands
status: PENDING
depends_on: []
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T01:43:16Z"
claimed_by: null
claimed_at: null
---

# Ship shell completions

## Description

Completion is table stakes for a CLI used interactively. Beyond command and flag names, the high-value completions are dynamic: task ids, phase names, and the project's configured statuses.

## Acceptance criteria

- [ ] `tasks completions <bash|zsh|fish>` prints a completion script
- [ ] Command and flag names complete
- [ ] Task ids complete for commands taking `<id>`
- [ ] Phase names complete for `--phase` and `tasks new`
- [ ] Statuses complete for `tasks status` from `config.yml`, not a hardcoded list
- [ ] Installation instructions per shell in the README

## Notes

Dynamic completions must stay fast — they run on every Tab. Reuse the existing tree load and avoid resolving cross-repo dependencies, which can touch other filesystems.
