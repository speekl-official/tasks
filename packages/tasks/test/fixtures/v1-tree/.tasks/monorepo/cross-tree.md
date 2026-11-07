---
id: cross-tree
phase: monorepo
status: PENDING
depends_on: []
created: "2026-08-22T01:43:17Z"
updated: "2026-08-22T01:43:17Z"
claimed_by: null
claimed_at: null
---

# Aggregate tasks across nested .tasks trees

## Description

Discovery is nearest-wins with no merging, so in a monorepo where several packages each own a `.tasks/`, there is no way to ask "what is ready anywhere in this repo". This was an explicit v1 non-goal, deferred until it was a real problem.

Cross-repo `depends_on` already proves multiple trees can be read safely in one invocation.

## Acceptance criteria

- [ ] `--recursive` on `list` and `ready` spans every `.tasks/` tree beneath the repo root
- [ ] Output is grouped by project, since ids are only unique within a tree
- [ ] Writes remain scoped to the single resolved tree — no cross-tree mutation
- [ ] Duplicate ids across trees are disambiguated rather than silently collapsed
- [ ] Documented interaction with `active_phase`, which is per-tree

## Notes

The uniqueness guarantee is per-tree, so any aggregated output must qualify ids by project or it will mislead an agent that assumes global uniqueness.
