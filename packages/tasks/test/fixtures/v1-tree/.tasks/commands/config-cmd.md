---
id: config-cmd
phase: commands
status: PENDING
depends_on: []
created: "2026-08-22T01:43:17Z"
updated: "2026-08-22T01:43:17Z"
claimed_by: null
claimed_at: null
---

# Add tasks config to read and write config.yml

## Description

Changing `active_phase` — the most commonly adjusted setting — means hand-editing YAML. Provide read/write access through the CLI, with validation applied before anything is written.

## Acceptance criteria

- [ ] `tasks config get [key]` prints one value, or the whole resolved config
- [ ] `tasks config set <key> <value>` writes and re-validates before saving
- [ ] Writes are atomic and reject a config that would fail load-time validation
- [ ] Resolved role defaults are visible, so `roles.claimed` shows its derived value
- [ ] `--json` output for both subcommands

## Notes

Rewriting config.yml will drop its explanatory comments, the same tradeoff frontmatter already makes. Either preserve comments or warn on first write — decide before shipping.
