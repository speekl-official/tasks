---
id: release-workflow
phase: release
status: PENDING
depends_on: [versioning]
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T01:43:23Z"
claimed_by: null
claimed_at: null
---

# Automate npm release from a git tag

## Description

Publishing is currently a manual `npm publish`. Add a GitHub Actions workflow that publishes `@speekl/tasks` when a release is cut, so releases are reproducible and auditable.

The package is scoped and already carries `publishConfig.access: public`; the workflow must not silently publish privately.

## Acceptance criteria

- [x] Workflow triggers on a version tag (or the Changesets release PR being merged)
- [x] Runs the full verify gate (lint, check-types, test, build) before publishing
- [x] Publishes with npm provenance enabled
- [x] Uses an `NPM_TOKEN` repository secret, never a committed credential
- [x] A dry-run path exists so the workflow can be exercised without publishing

## Notes

`prepublishOnly` already runs the verify gate locally; CI should not rely on that alone, since `--ignore-scripts` would skip it.

### 2026-08-24

`.github/workflows/release.yml` publishes on a `v*` tag: full gate, then two
guards (the tag must match `packages/tasks/package.json`, and the version must
not already be on the registry), then `npm publish --provenance --access
public`. `workflow_dispatch` runs the same job against `npm publish --dry-run`
and never touches the registry.

Provenance needs `id-token: write`, which is why the job publishes through `npm`
rather than `pnpm publish`. The token lives in a GitHub **environment** named
`npm` — add required reviewers there to gate every publish on an approval.
`PUBLISHING.md` was rewritten around this flow; the manual path survives as a
documented fallback that forfeits provenance.

Untested end to end: the repo has no remote yet, so the workflow has never run.
Rehearse with the dry-run dispatch before the first tag.
