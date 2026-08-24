---
id: publish-v1
phase: release
status: PENDING
depends_on: [versioning, release-workflow, cross-platform-ci]
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T01:43:23Z"
claimed_by: null
claimed_at: null
---

# Publish the first release to npm

## Description

Ship `@speekl/tasks` publicly so it can be installed with `npm i -g @speekl/tasks` and run via `npx`. The scope exists because unscoped `tasks` is already taken on npm by a squatted v0.0.3.

Gated on the release plumbing so the first publish is done by the same automation that will do every later one.

## Acceptance criteria

- [ ] The `@speekl` npm scope/org exists and the account has publish rights
- [x] `npm pack --dry-run` contents reviewed
- [ ] Published via the release workflow, not a local `npm publish`
- [ ] `npx @speekl/tasks --help` works from a clean machine
- [ ] Install and first-run instructions in the README verified against the published package

## Notes

Confirm the `tasks` bin is executable after a global install, not just under a workspace link.

### 2026-08-24

Tarball re-reviewed at 60.2 kB / 8 files: `dist/index.js` + its sourcemap,
`skill/SKILL.md`, `skill/reference/convention.md`, `README.md`, `LICENSE`,
`CHANGELOG.md`, `package.json`. Nothing from `src/`, `test/`, or `.turbo/`. The
earlier note ("49.6 kB, exactly four files") predates the bundled skill.
