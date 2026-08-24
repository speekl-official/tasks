---
id: versioning
phase: release
status: DONE
depends_on: []
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T21:51:48Z"
claimed_by: null
claimed_at: null
---

# Set up versioning and changelog

## Description

There is no version-bump or changelog process. Adopt Changesets so every user-facing change lands with an intent-to-release note, and `CHANGELOG.md` is generated rather than hand-written.

This is the first release task because both `release-workflow` and `publish-v1` build on the version it produces.

## Acceptance criteria

- [ ] `@changesets/cli` installed and initialised at the repo root
- [ ] `pnpm changeset` produces a changeset file for a sample change
- [ ] `pnpm changeset version` bumps `packages/tasks` and writes `CHANGELOG.md`
- [ ] Changesets config ignores private workspace packages
- [ ] Contributing notes in the root README explain when a changeset is required

## Notes

The verification bump (0.1.0 -> 0.1.1) was reverted deliberately: 0.1.0 is not
published yet, so the first release should still be 0.1.0. Changesets governs
every version from 0.1.0 onward; the 0.1.0 changelog entry is seeded by hand.

`pnpm changeset status` exits 1 until the first release, because the already
committed work has no changesets behind it. Expected pre-publish; `release-workflow`
should not gate CI on it until after `publish-v1`.

`packages/tasks/CHANGELOG.md` was converted from Keep a Changelog to the
Changesets format (`# @speekl/tasks` title, `## <version>` sections). Changesets
inserts after the first line, so the old preamble and link refs would have been
pushed below the newest release.

Changesets over semantic-release: the repo is a monorepo that will gain a website app, and Changesets handles per-package versioning without coupling releases to commit-message discipline.
