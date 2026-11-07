---
id: config-migrations
phase: integrity
status: PENDING
depends_on: []
created: "2026-08-22T01:43:17Z"
updated: "2026-08-22T01:43:17Z"
claimed_by: null
claimed_at: null
---

# Support config schema migrations

## Description

`config.yml` carries `version: 1` specifically to allow safe migration later, but no migration path exists — a future `version: 2` would simply fail zod validation with an opaque error.

Define the upgrade path before the schema needs to change, while there is exactly one version to reason about.

## Acceptance criteria

- [ ] Loading a config with a newer version than the CLI supports fails with an actionable message naming the CLI version needed
- [ ] A migration registry maps version N to N+1
- [ ] `tasks migrate` upgrades config.yml in place, atomically
- [ ] Round-trip test: a v1 config migrates and still validates

## Notes

Task frontmatter has no version field. Decide now whether it needs one, or whether frontmatter changes must stay backward compatible forever.
