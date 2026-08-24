# @speekl/tasks

## 0.1.0

Initial release.

### Added

- `tasks init` — scaffold `.tasks/` with config, README, and gitignore, and
  install the agent skill (`--no-skill` opts out).
- `tasks new` / `show` / `list` / `ready` — create and read tasks.
- `tasks claim` / `release` / `status` — task ownership and lifecycle.
- `tasks dep add|rm|list` — dependency management with cycle detection.
- `tasks move` / `delete` — relocate a task's phase, archive or purge.
- `tasks reindex` / `validate` — regenerate `_index.md`, check tree integrity.
  `validate` warns when a committed `_index.md` no longer matches the tasks on
  disk, and `--fix` regenerates it; it stays a warning, because the index is not
  a source of truth and CI should not fail on it.
- `tasks skill install [--force]` — install the bundled agent skill into
  `.claude/skills/tasks/`, so agents discover the convention on their own.
- `--json` on every command, with meaningful exit codes (0 ok, 2 usage,
  3 not found, 4 conflict).

Requires Node 20 or newer.
