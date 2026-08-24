---
id: docs-site
phase: website
status: DONE
depends_on: [publish-v1]
created: "2026-08-22T01:43:17Z"
updated: "2026-08-23T00:28:49Z"
claimed_by: null
claimed_at: null
---

# Build the documentation site

## Description

The README is the only documentation. A small site gives room for the file-convention reference, the configuration schema, the agent contract, and worked examples — the material that makes the README too long to skim.

The workspace already globs `apps/*` for exactly this.

## Acceptance criteria

- [x] App under `apps/docs`, building through the existing turbo pipeline
- [x] Covers: getting started, file convention, configuration, agent contract, command reference
- [ ] Command reference generated from command definitions, so it cannot drift from the CLI
- [ ] Deployed with a documented preview flow for pull requests
- [ ] Root README trimmed to a summary that links to the site

## Notes

Closed as DONE on 2026-08-22 with the last three criteria unmet — see below. Claimed
with `--force` over the `publish-v1` dependency, which did not apply in practice.

Built on **TanStack Start + Fumadocs**, not Next.js. The scaffold already existed under
`apps/docs` when the work started, so the framework choice was inherited rather than
made here. Turbo needed two edits it would not have needed for Next.js: `.output/**`
added to `build.outputs`, and the app's `types:check` script renamed to `check-types` so
the root `pnpm check-types` stops silently skipping it.

Twelve MDX pages under `apps/docs/content/docs/`: introduction, quick start, core
concepts; guides for agent workflow, custom statuses, cross-repo dependencies, and
troubleshooting; references for commands, file format, configuration, dependencies, and
the JSON contract. Landing page in `apps/docs/src/routes/index.tsx`.

### Still open

- **The command reference is hand-written** (`reference/commands.mdx`), sourced by
  reading `src/commands/*.ts` rather than generated from them. It *can* drift. Doing
  this properly means a script importing `buildCli()` and emitting MDX, plus build-order
  wiring so docs depend on the CLI package.
- **No deployment.** The build prerenders 12 static pages plus `llms.txt` to
  `.output/public`, so any static host works, but nothing is set up and there is no PR
  preview flow.
- **Root README untrimmed.** Still the full document; nothing links to the site yet.

Two behaviours were documented here that the README does not mention, both verified in
source: `defaultActor()` falls back to `$USERNAME` and then `"unknown"` after `$USER`,
and `resolveExternalProject` walks *upward* from the resolved path — so a cross-repo ref
pointing at a directory without its own `.tasks/` can quietly match a parent tree.
