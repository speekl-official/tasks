# Publishing `@speekl/tasks`

Releases are published by `.github/workflows/release.yml`, which triggers on a
`v*` tag. The tag is the only thing that publishes: CI itself
(`.github/workflows/ci.yml`) never touches the registry.

Publishing from CI is what makes [npm
provenance](https://docs.npmjs.com/generating-provenance-statements) possible —
the workflow signs the package with the repo, commit, and workflow that built
it, which cannot be reproduced from a laptop.

## One-time setup

1. Be a member of the `speekl` npm org with publish rights on the scope.
2. Create an **automation** access token on npmjs.com (Access Tokens →
   Granular/Automation). An automation token bypasses 2FA, which a workflow
   cannot answer.
3. In the GitHub repo, create an environment named `npm`
   (Settings → Environments) and add the token as the secret `NPM_TOKEN`.
   Adding yourself as a required reviewer there gives every publish a manual
   approval step.
4. The scope is public and `publishConfig.access` is already `public`, so no
   paid npm plan is needed.

## Release checklist

1. **Check what is pending.** Every user-facing change should already have a
   changeset from its own PR — see the contributing notes in the root
   `README.md`.

   ```sh
   pnpm changeset status
   ```

   If a merged change is missing one, add it now with `pnpm changeset` rather
   than editing the version or changelog by hand.

   Before the first release this exits 1 ("no changesets were found"), because
   the committed work predates Changesets. That is expected, and stops once
   0.1.0 is out.

2. **Apply the changesets.** This bumps `packages/tasks/package.json`, writes
   `packages/tasks/CHANGELOG.md`, and deletes the consumed changeset files.
   `tasks -v` is injected from `package.json` at build time, so the bump is all
   that is needed for the version to be correct everywhere.

   ```sh
   pnpm version-packages
   ```

   Review the diff before continuing — this is the last point where the version
   and the changelog are easy to correct. Both are generated; never hand-edit
   them.

3. **Verify everything from the repo root.**

   ```sh
   pnpm release:check
   ```

   This lints, typechecks, tests, builds, and packs a tarball into `/tmp` so you
   can inspect exactly what ships.

4. **Inspect the tarball contents.**

   ```sh
   cd packages/tasks && npm pack --dry-run
   ```

   Expect only `dist/`, `skill/`, `README.md`, `LICENSE`, `CHANGELOG.md`, and
   `package.json` — eight files. Nothing from `src/`, `test/`, or `.turbo/`.

5. **Smoke-test the built CLI against a scratch directory**, so you exercise the
   real bin rather than the test sandbox.

   ```sh
   mkdir -p /tmp/tasks-smoke && cd /tmp/tasks-smoke && git init -q
   node /path/to/tasks/packages/tasks/dist/index.js init
   node /path/to/tasks/packages/tasks/dist/index.js new setup "First task"
   node /path/to/tasks/packages/tasks/dist/index.js ready --json
   ```

   The `cli` CI job runs this same sequence on Linux and Windows, on Node 22 and
   24 — the range `engines` claims.

6. **Rehearse the release workflow.** Run it from the Actions tab
   (Release → Run workflow) with `dry_run` left on. It runs the full gate and
   `npm publish --dry-run` without touching the registry.

7. **Commit, tag, and push.** The tag is what publishes, and the workflow
   refuses to run if the tag does not match `packages/tasks/package.json`, or if
   that version is already on the registry.

   ```sh
   git commit -am "release: @speekl/tasks v0.1.0"
   git tag v0.1.0
   git push origin main --tags
   ```

   The commit includes the generated version bump, the changelog, and the
   removal of the consumed changeset files.

8. **Watch the run.** If the `npm` environment has required reviewers, approve
   it there. The workflow re-runs lint, typecheck, tests, and build before
   publishing; `prepack` rebuilds `dist/` so a stale build can never ship.

9. **Verify the published package.**

   ```sh
   npx @speekl/tasks@latest --version
   ```

   The npm page should show the green **Provenance** panel pointing at the
   release run.

## Publishing by hand

Only if the workflow is unavailable. This forfeits provenance.

```sh
npm login                      # 2FA will prompt for an OTP
cd packages/tasks
pnpm publish --access public   # --dry-run to rehearse
```

## Notes

- **Unpublishing** is only possible within 72 hours of publishing. Prefer
  `npm deprecate` for a bad release, and ship a patch.
- **First publish of a scoped package** defaults to restricted; `publishConfig`
  in `packages/tasks/package.json` already overrides that to `public`.
- **Provenance requires a public repo** and the `id-token: write` permission,
  both already in place in `release.yml`.
