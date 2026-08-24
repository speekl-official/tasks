---
name: tasks
description: >-
  Read and update persistent, git-versioned tasks in a repo's .tasks/ directory
  through the `tasks` CLI. Use when work spans multiple sessions, when tasks
  depend on each other, or when several agents or people coordinate through git.
  Not for within-session checklists — use ordinary session todos for those.
when_to_use: >-
  Use whenever the repo has a .tasks/ directory, or the user asks what to work
  on next, to claim or finish a task, what is blocked, to add or re-scope a
  task, or to plan work that must outlive this session.
allowed-tools: Bash(tasks:*)
---

Tasks live in `.tasks/` as markdown with YAML frontmatter, versioned by git.
The `tasks` CLI owns the frontmatter and enforces the rules below; the markdown
body is freeform and safe to edit directly.

## Before anything else

```sh
tasks list --json
```

Exit `3` with `NO .tasks/ directory found` means this project isn't set up. Ask
before running `tasks init` — creating it is a project-level decision, not a
side effect of a question about work.

If `tasks` is not on PATH, use `npx @speekl/tasks` in place of `tasks`
everywhere below.

## The working loop

```sh
tasks ready --json                  # unblocked and available right now
tasks claim <id>                    # take it — records who and when
# ...do the actual work...
tasks status <id> DONE              # complete it
```

Claim before working, not after. The claim is what stops a second agent from
starting the same task, and it is only useful if it happens first.

Update status as you go rather than batching at the end. A session that dies
mid-task leaves a claimed task, which is recoverable; one that leaves everything
`PENDING` loses the work record entirely.

## Rules that will bite you

- **Never hand-edit frontmatter.** Every field has a command: `status`, `claim`,
  `release`, `dep add`/`dep rm`, `move`. Editing YAML directly bypasses the
  transition and dependency checks that make the tree trustworthy. The body
  below the frontmatter is yours — edit it freely with normal file tools.
- **Never `mv` a task file.** The directory determines the phase. Use
  `tasks move <id> <phase>`.
- **No status skipping.** By default a task steps forward or back exactly one
  status, so `PENDING → DONE` is rejected. Claim it first.
- **`tasks status <id> IN_PROGRESS` is refused** (exit `2`) — it redirects to
  `tasks claim`, so claim metadata can never be bypassed.
- **A `CONFLICT` on claim means someone else has it.** Pick a different task
  from `tasks ready`. Do not reach for `--force`.
- **`--force` on claim overrides *dependencies*, not other people's claims.**
  Only use it when the user explicitly says the dependency doesn't apply.
- **The last status is not terminal.** To reopen a completed task,
  `tasks claim <id>` steps it back from `DONE`.
- **Status names are project-configurable.** `PENDING`/`IN_PROGRESS`/`DONE` are
  defaults, not guarantees — a project may use `[TODO, DOING, REVIEW, SHIPPED]`.
  Read the real list from `.tasks/config.yml` or an error's
  `details.statuses` rather than assuming.

## Machine-readable contract

Every command accepts `--json`. Use it whenever you parse output; the plain
tables are for humans and their layout is not stable.

- Success goes to **stdout**. Under `--json`, errors go to **stderr** as
  `{"error": {"code", "message", "details"}}`.
- Exit codes: `0` success, `1` internal, `2` usage, `3` not found,
  `4` state conflict. **Branch on the code, never on message text.**
- **An empty result is success**, not an error — `tasks ready` with nothing
  available exits `0` with `{"count": 0, "tasks": []}`.

`ready`, `list` → `{phase, count, tasks[]}`. `new`, `show`, `claim`, `release`,
`status`, `move`, `dep add`/`rm` → a single task object. Task objects carry
`id`, `phase`, `status`, `depends_on`, `created`, `updated`, `claimed_by`,
`claimed_at`, `path`; `show` adds `title`, `ready`, `dependencies`, `body`.

Chaining works because ids are stable and globally unique:

```sh
id=$(tasks ready --json | jq -r '.tasks[0].id // empty')
[ -n "$id" ] && tasks claim "$id"
```

## Creating tasks

```sh
tasks new <phase> <name...> [--id <id>]
tasks dep add <id> <ref>...
```

The phase directory is created on first use — there is no separate step. The id
defaults to a kebab-case slug of the name and must be unique across the whole
tree, including `.archive/`.

Write the body after creating: `tasks new` scaffolds `## Description`,
`## Acceptance criteria`, and `## Notes`. Fill them in with a normal file edit
at the `path` returned in the JSON. A task whose body is empty is not a task,
it is a reminder — put enough in it that a different agent arriving cold in a
later session can do the work without asking.

Prefer several small dependent tasks over one large one. `depends_on` is what
makes `tasks ready` meaningful; a single task with a ten-item checklist in its
body tells the next agent nothing about what is unblocked.

## Full command reference

| Command | Purpose |
| --- | --- |
| `tasks init [--force]` | Scaffold `.tasks/`. Ask the user first. |
| `tasks new <phase> <name...> [--id]` | Create a task; phase auto-created. |
| `tasks list [-p <phase>] [-a] [-s <status>]` | List tasks, filterable. |
| `tasks show <id>` | Full metadata, resolved dependencies, and body. |
| `tasks ready [-p <phase>] [-a]` | Unblocked and available. |
| `tasks claim <id> [--as <who>] [--force]` | Take ownership. |
| `tasks release <id>` | Return a claimed task to the ready pool. |
| `tasks status <id> <STATUS>` | Move through the lifecycle. |
| `tasks dep add\|rm\|list <id> [<ref>...]` | Manage dependencies. |
| `tasks move <id> <phase>` | Reassign phase, relocating the file. |
| `tasks delete <id> [--force] [--purge]` | Archive; `--purge` removes. |
| `tasks reindex` | Regenerate `_index.md`. |
| `tasks validate [--fix]` | Check tree integrity. |

Without `-p`/`-a`, `list` and `ready` scope to `active_phase` from
`.tasks/config.yml` when it is set. If a task you expect is missing, retry with
`--all` before concluding it does not exist.

## When something looks wrong

Run `tasks validate --json` before hand-repairing anything. It reports
id/filename mismatches, phase drift, unknown statuses, broken or cyclic
dependencies, and a stale `_index.md`; `--fix` repairs the mechanically safe
subset and leaves the rest for a human. Do not fix drift by editing YAML.

## Deeper reference

For the file format, `config.yml` schema, custom statuses and transitions,
cross-repo dependencies, and dependency-resolution semantics, read
`${CLAUDE_SKILL_DIR}/reference/convention.md`. Load it only when you need to
hand-author a task file, change project config, or interpret a `validate`
finding.
