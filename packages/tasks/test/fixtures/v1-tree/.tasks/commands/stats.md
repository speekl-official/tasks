---
id: stats
phase: commands
status: PENDING
depends_on: []
created: "2026-08-22T01:43:17Z"
updated: "2026-08-22T01:43:17Z"
claimed_by: null
claimed_at: null
---

# Add tasks stats for a status and phase summary

## Description

There is no way to see the shape of a backlog at a glance — how many tasks sit in each status, which phases are active, how many tasks are blocked versus ready.

## Acceptance criteria

- [ ] `tasks stats [--phase <p>] [--all]` prints counts by status and by phase
- [ ] Reports ready versus blocked counts, reusing the dependency resolver
- [ ] Reports how many tasks are claimed and by whom
- [ ] `--json` output suitable for a dashboard or CI summary

## Notes

Blocked counts need the resolver, which can hit external trees. Keep the cross-repo lookups cached per invocation as `DependencyResolver` already does.
