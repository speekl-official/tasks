# Tasks

This directory is a local, git-versioned task tracker. It is managed by the
`tasks` CLI. Task files are plain markdown and safe to read directly; prefer
the CLI for any change, because it enforces the rules below.

## Layout

```
.tasks/
  config.yml      project config (statuses, roles, active_phase)
  README.md       this file
  _index.md       generated overview — regenerate with `tasks reindex`
  <phase>/        a phase directory, e.g. auth-rework/ or 2026-q1/
    <id>.md       one task
  .archive/       soft-deleted tasks, excluded from all default queries
```

## For an agent starting work

```sh
tasks ready --json       # what is unblocked right now
tasks claim <id>         # take it (fails if someone already has it)
# ...do the work...
tasks status <id> DONE   # complete it
```

Every read command accepts `--json`. Errors are JSON on stderr under
`--json`, and exit codes are meaningful: 0 success, 2 usage, 3 not found,
4 state conflict. Branch on the exit code, not on message text.

## Rules the CLI enforces

- **Status transitions.** By default a task moves forward or back exactly one
  status at a time, so nothing jumps straight to done without being worked.
- **Dependencies.** `depends_on` lists task ids. A task is only "ready" when
  every dependency is done. Missing, archived, and cyclic dependencies all
  count as blocking, never as satisfied.
- **Ids are globally unique** across this directory, including `.archive/`.
- **The directory owns a task's phase**; use `tasks move` rather than `mv`.

## Frontmatter

The YAML block at the top of each task is machine-owned — the CLI rewrites it
in canonical form and does not preserve comments there. The markdown body below
it is yours: edit it freely. If frontmatter is hand-edited into an inconsistent
state, `tasks validate` reports it and `tasks validate --fix` repairs the
mechanically safe parts.
