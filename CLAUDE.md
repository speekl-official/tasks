# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

pnpm + turbo monorepo. Two workspaces: `packages/tasks` (`@speekl/tasks`), a CLI that manages a
`.tasks/` markdown tree for coding agents — the only published package — and `apps/docs`, the
private docs site at [agenttasks.dev](https://agenttasks.dev) (TanStack Start + Fumadocs), whose
`content/docs/spec/` is the normative `.tasks` convention.

Development requires Node 22.13+ (pnpm 11's floor); the published CLI supports Node 20+.

## Commands

Run from the repo root; turbo fans out. `pnpm test` depends on `^build`.

```sh
pnpm lint && pnpm check-types && pnpm test && pnpm build   # what CI runs, in order
pnpm release:check                                          # the above, plus a packed tarball
```

Single test, from `packages/tasks/`: `npx vitest run -t "regenerates a stale _index.md"`.

Exercise the real bin, not just the sandbox: `node packages/tasks/dist/index.js <cmd>` after a build.

## The CLI's public API

Agents branch on these, so they are contract, not implementation:

- **Exit codes** (`src/errors.ts`): 0 success, 1 internal, 2 usage, 3 not found, 4 conflict.
- **`--json` shapes** — every read command accepts `--json`; errors go to stderr as JSON.
- **`.tasks/` on-disk conventions** — frontmatter fields, directory-as-phase, id/filename mirroring.

Changing any of the three is a `major` changeset, never a `patch`.

## Code conventions

- ESM with `verbatimModuleSyntax`: relative imports carry the `.js` extension (`../core/repo.js`),
  and type-only imports are separate (`import type { Task } from ...`) — eslint enforces both.
- `no-console` is an eslint error. All output goes through `src/output.ts` (`writeOut`, `writeErr`,
  `emitJson`) so the stdout/stderr split and the `--json` contract stay in one place.
- Throw `TaskError.usage/notFound/conflict/internal` rather than bare `Error`; the exit code and the
  JSON error body derive from it.
- Prettier (`printWidth: 80`) is authoritative. Much of `src/` predates that and does not conform;
  format the files you touch rather than assuming the surrounding width is correct.

## Definition of done for a user-facing change

Anything a user of `@speekl/tasks` could notice needs all of this in the same change:

1. A changeset (`pnpm changeset`) — bump per the table in the root `README.md`.
2. Docs that mirror behavior, all three surfaces: `packages/tasks/README.md`,
   `packages/tasks/skill/SKILL.md` (plus `skill/reference/convention.md` if the file layout
   changed), and the docs site under `apps/docs/content/docs/` — `reference/` describes the CLI,
   `spec/` is normative and changes there come first.
3. The full gate above, passing.

Tests, refactors with no behavior change, and CI edits need no changeset.

Never hand-edit `packages/tasks/CHANGELOG.md` or a `version` field — Changesets generates both.

## Gotchas

- **The skill has two copies.** `packages/tasks/skill/` is the source that ships in the npm package;
  `.claude/skills/tasks/` is an installed copy in this repo. Edit the source. The installed copy
  refreshes via `tasks skill install --force`.
- **This repo dogfoods its own tracker.** Work is tracked in `.tasks/`. Use the CLI: `tasks ready`,
  `tasks claim <id>`, `tasks status <id> DONE`. Run `tasks reindex` afterward — `_index.md` is
  committed and only regenerates on demand.
- **Don't commit or push.** Dan commits. Leave the working tree with the changes in it.
