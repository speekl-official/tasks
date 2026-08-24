# The `.tasks/` convention

Reference for the file format and project configuration. Read this when you
need to hand-author or repair a task file, change `config.yml`, or interpret a
`tasks validate` finding. For the day-to-day workflow, `SKILL.md` is enough.

## Directory layout

```
.tasks/
  config.yml        project config — statuses, roles, transitions, active_phase
  README.md         the convention, scaffolded by `tasks init`
  .gitignore        self-contained; ignores .locks/
  _index.md         generated view; regenerate with `tasks reindex`
  <phase>/          a phase: free-form slug, e.g. auth-rework/ or 2026-q1/
    <id>.md         one task, filename always matches its `id`
  .archive/         soft-deleted tasks, excluded from every default query
  .locks/           transient claim locks, git-ignored
```

A phase is a directory, not just a tag, so humans can browse one body of work
and queries can scope to it. A project that doesn't want phases can put
everything in one directory and never pass `--phase`.

`.tasks/` is discovered by walking up from the current directory, git-style:
**nearest wins, no merging** with a parent tree. Each package in a monorepo with
its own `.tasks/` is its own independent scope.

## Task file format

```markdown
---
id: design-token-schema
phase: auth-rework
status: PENDING
depends_on: [other-task]
created: "2026-08-21T09:14:00Z"
updated: "2026-08-21T09:14:00Z"
claimed_by: null
claimed_at: null
---
# Design token schema

## Description

## Acceptance criteria

- [ ]

## Notes
```

The frontmatter is **machine-owned**: the CLI rewrites it in canonical form and
does not preserve comments or key order there. The markdown body is yours.

| Field | Notes |
| --- | --- |
| `id` | Stable slug, globally unique across the whole tree including `.archive/`. The filename is always `<id>.md`. |
| `phase` | Mirrors the containing directory. **The directory is authoritative** — `validate --fix` rewrites this field to match. |
| `status` | Must be one of `config.yml`'s `statuses`. |
| `depends_on` | List of refs; see below. |
| `created` / `updated` | Quoted ISO 8601 UTC strings. Quoted so YAML parses them as strings, not dates. |
| `claimed_by` / `claimed_at` | Set by `claim`, cleared when the task leaves the claimed status. |

Writes are atomic (temp file + rename), so a task file is never observed
half-written and diffs stay reviewable.

## Statuses, roles, and transitions

Statuses are an ordered, project-configurable list. Default:
`[PENDING, IN_PROGRESS, DONE]`. **No command hardcodes a literal status** —
each binds to one of three roles:

| Role | Meaning | Default |
| --- | --- | --- |
| `ready` | What `tasks ready` looks for | first status |
| `claimed` | What `tasks claim` moves to | second status |
| `done` | What satisfies another task's `depends_on` | last status |

That is why a project can use `[TODO, DOING, REVIEW, SHIPPED]` and every command
still works. Always read the real list rather than assuming the defaults.

**Default transition rule:** step forward or back by exactly one, uniformly. No
forward skipping, so nothing reaches done without being worked. The last status
is deliberately **not** terminal — stepping back from it is the supported
reopen path, because agents do mark things done in error.

Providing an explicit `transitions` list in `config.yml` **replaces** the
step-wise rule entirely rather than layering on it.

## `config.yml`

```yaml
version: 1                    # config schema version

active_phase: auth-rework     # optional; default scope for `list` and `ready`

statuses: [TODO, DOING, REVIEW, SHIPPED]   # optional; min 2 entries

roles:                        # optional; defaults to first / second / last
  ready: TODO
  claimed: DOING
  done: SHIPPED

transitions:                  # optional; REPLACES the default step rule
  - [TODO, DOING]
  - [DOING, REVIEW]
  - [REVIEW, SHIPPED]
  - [SHIPPED, DOING]
```

Unknown keys are rejected. The config is validated on load: roles and
transitions must name real statuses, and a config where `ready → claimed` is
illegal is refused outright rather than failing later at `tasks claim`.

`BLOCKED` and `CANCELLED` are not special-cased — add them to `statuses` if you
want them. `depends_on` already expresses blocking, and cancellation is normally
`tasks delete`.

## Dependencies

A ref is either a bare id in this project, or `<relative-path>:<id>` pointing
into another repo's `.tasks/`:

```yaml
depends_on: [token-schema, ../upstream-repo:publish-endpoint]
```

Cross-repo paths resolve relative to the **project root**, never the current
directory, so frontmatter means the same thing from any subdirectory. Absolute
paths are rejected because they don't survive a clone. The other project is
read-only, and the dependency is judged against *that* project's `done` role.

**Dependencies fail safe.** Every unsatisfied state counts as blocking, never as
satisfied, so a typo can delay work but can never let an agent start something
prematurely. `tasks dep list <id> --json` reports a `reason` per dependency:

| Reason | Meaning |
| --- | --- |
| `not-done` | Exists, but not in the `done` role yet |
| `missing` | No such task id |
| `archived` | Soft-deleted; archived tasks never satisfy a dependency |
| `unresolved-project` | A cross-repo path that doesn't resolve |

`tasks dep add` refuses a ref to a nonexistent task and refuses to introduce a
cycle. Ids stay reserved after deletion, so a new task can never silently
inherit a deleted task's inbound dependencies.

## Claim locking

`tasks claim` takes an exclusive `O_EXCL` lock in `.locks/` and re-reads state
inside it, so two concurrent processes cannot both take the same task. A lock
left by a crashed process goes stale after 10s and is reclaimed.

This protects concurrent agents **on one filesystem**. It does not coordinate
across separate clones — two agents on two clones can both claim the same task
and only find out at merge. For multi-clone work, treat claims as advisory.

## `tasks validate` findings

| Kind | Fixable by `--fix` |
| --- | --- |
| `filename-mismatch` | yes — file renamed to match `id` |
| `phase-drift` | yes — `phase` rewritten to the containing directory |
| `malformed` | no |
| `duplicate-id` | no |
| `unknown-status` | no |
| `malformed-ref` | no |
| `cycle` | no |
| `dependency-missing` / `dependency-archived` / `dependency-unresolved-project` | no |

`--fix` applies only the mechanically safe repairs and reports the rest for a
human. Exit `0` with `{"ok": true, "findings": []}` means the tree is clean.

## Error shape

Under `--json`, errors go to stderr:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Illegal transition PENDING -> DONE. Allowed from PENDING: IN_PROGRESS.",
    "details": { "id": "implement-refresh", "from": "PENDING", "to": "DONE", "allowed": ["IN_PROGRESS"] }
  }
}
```

`code` is one of `USAGE` (exit 2), `NOT_FOUND` (exit 3), `CONFLICT` (exit 4),
`INTERNAL` (exit 1). `details` carries the structured facts — prefer it over
parsing `message`, which is written for humans and may change.
