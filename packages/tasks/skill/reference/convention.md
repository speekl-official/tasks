# The `.tasks/` convention, v2

Reference for the file layout, the task file and the project configuration. Read
this when you need to hand-author or repair a file, change `config.yml`, or
interpret a `tasks validate` finding. For the day-to-day workflow, `SKILL.md` is
enough. The normative text is at https://agenttasks.dev/docs/spec.

## Directory layout

```
.tasks/
  config.yml          REQUIRED: version: 2, plus optional scope, session timeout, archive threshold, actors, docs, projects
  README.md           describes the convention to a cold reader
  .gitignore          ignores .locks/
  index.md            optional generated overview; never a source of truth (validate only checks it is current)
  <segment>/          a group (no task.md) or a task (task.md), at any depth
    task.md           present => this directory is a task; its id is its path
    state.md          the resume point
    design.md         decisions and why
    plan.md           steps, files, verification
    log.md            history, appended by the CLI
    <anything else>   workspace content, never parsed
    <segment>/        a child task, a group, or workspace content
  .archive/           archived tasks at their former paths; the paths stay reserved; read with --archived
  .locks/             tree.lock and sessions/<token>; never committed
```

- Directory names that take part in the tree match `^[a-z0-9][a-z0-9-]*$`; the
  scanner skips `.archive/`, `.locks/` and every other dot-directory.
- A task's **id** is its path relative to `.tasks/`; its **name** the last
  segment; its **title** the first `# ` heading of the body.
- Its **parent** is the nearest ancestor directory that is a task; groups in
  between do not break parenthood. Children are parts of the parent's
  deliverable, never phases of its lifecycle.
- `.tasks/` is discovered by walking up from the current directory (or `-C`):
  nearest wins, no merging with a tree further up. In a linked git worktree the
  search starts at the same place in the main checkout, so the live tree is
  found, not the branch's snapshot; `-C` is literal.
- Every mutation runs under one lock per tree, `.locks/tree.lock`; writes are
  atomic (temp file + rename) and canonical, except `log.md`, which is appended
  in place because its bytes are never rewritten.

## Task file

```markdown
---
status: PAUSED
priority: normal
depends_on: [auth-rework/audit-claims]
finishes_after: []
assignee: alice
claimed_by: null
claimed_at: null
claimed_session: null
created: "2026-09-21T09:14:00Z"
updated: "2026-09-21T16:40:12Z"
---

# Design the token schema

## Description

## Acceptance criteria

- [ ]

## Notes
```

| Field             | Type                              | Notes                                                                                                               |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `status`          | one of the six statuses           | Changed only by the transition commands.                                                                            |
| `priority`        | `urgent`, `high`, `normal`, `low` | Default `normal`; effective priority is the highest among the ancestors.                                            |
| `depends_on`      | reference list                    | Start gate: each must be `DONE` before `claim` or `done`.                                                           |
| `finishes_after`  | reference list                    | Finish gate beyond the children: each must be `DONE` or `CANCELLED`.                                                |
| `assignee`        | actor or `null`                   | Who must act next; with the assignees of its ancestors, alone may transition the task while no live claim holds it. |
| `claimed_by`      | actor or `null`                   | Who is working on it now; set by `claim`.                                                                           |
| `claimed_at`      | timestamp or `null`               | When that claim was taken.                                                                                          |
| `claimed_session` | session token or `null`           | The claimant's session; `null` for a claim without one.                                                             |
| `created`         | timestamp                         | Never modified.                                                                                                     |
| `updated`         | timestamp                         | The last frontmatter change by the CLI.                                                                             |

- The claim fields are set and cleared together: non-null exactly while
  `IN_PROGRESS` (`claimed_session` may stay `null`), `null` otherwise.
- Actors and session tokens match `^[A-Za-z0-9][A-Za-z0-9._@+-]*$`.
- **Canonical form:** the ten fields in this order, then unknown keys in the
  order read, values unchanged; lists as flow sequences (`[a, b]`, `[]`);
  timestamps double-quoted ISO 8601 UTC with `Z`; other scalars quoted only when
  plain YAML would be ambiguous (an external reference, with its colon, is
  quoted). Comments are not kept. Repeated writes produce identical bytes.
- **Body:** `## Description` and `## Acceptance criteria` define the task and
  change in place when clarified; `## Notes` collects inputs received after the
  start. Progress never goes into the body.

## Statuses and situations

| Status        | Fact                                     | Open?    |
| ------------- | ---------------------------------------- | -------- |
| `BACKLOG`     | not scheduled                            | open     |
| `TODO`        | scheduled, not started                   | open     |
| `IN_PROGRESS` | being worked now; a claimant is recorded | open     |
| `PAUSED`      | started, not being worked                | open     |
| `DONE`        | finished                                 | resolved |
| `CANCELLED`   | decided not to do                        | resolved |

Overviews show one **situation** per task, the first that holds: `done`,
`cancelled`, `working by X`, `parked` (`BACKLOG` with a `state.md` at or beneath it),
`backlog`, `held by X` (an ancestor is claimed or assigned), `waiting for X`
(`PAUSED` with an assignee), `assigned X`, `blocked by X`, `closable` (children
and joins all resolved), `open N/M` (a parent with open children),
`ready`. Secondary labels follow, in this order: `started` (the task's own
`state.md`), `blocked by X`, `active`, liveness, the assignee, `held by X` and
`closable` — the last three only when they are not the situation itself. The
effective priority has a column of its own: blank for `normal`,
`high (inherited)` when it is an ancestor's.

A task is **ready** for an actor when it is `TODO` or `PAUSED`, every
`depends_on` reference is `DONE`, it is assigned to nobody or to that actor, it
has no live open child, and no ancestor is claimed or assigned. The ready order
is effective priority, then `PAUSED` before `TODO`, then `created`.

## Transitions

| Command                          | From → to                                                                                     | Requires                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `schedule`                       | `BACKLOG` → `PAUSED` with a `state.md`, else `TODO`                                           | no `BACKLOG` ancestor; cascades                      |
| `defer`                          | `TODO`, `PAUSED` → `BACKLOG`                                                                  | no live claim beneath; cascades                      |
| `claim`                          | `BACKLOG`, `TODO`, `PAUSED` → `IN_PROGRESS`                                                   | start gate; parent open; no held or backlog ancestor |
| `pause`                          | `IN_PROGRESS` → `PAUSED`; a person's sets `assignee`                                          | `state.md`; message                                  |
| `release`                        | `IN_PROGRESS` → `TODO`                                                                        | no `state.md`                                        |
| `done`                           | open → `DONE`                                                                                 | start and finish gates; message                      |
| `cancel`                         | open → `CANCELLED`                                                                            | no live claim beneath; message; cascades             |
| `reopen`                         | resolved → `BACKLOG` under a `BACKLOG` ancestor, else `PAUSED` with a `state.md`, else `TODO` | parent open; message                                 |
| `handoff <actor>`                | `IN_PROGRESS` → `PAUSED`, assignee set                                                        | `state.md`; message                                  |
| `assign`, `unassign`, `priority` | open, unchanged                                                                               |                                                      |

- **Cascades:** `defer` sends every open descendant to `BACKLOG` (keeping
  `state.md` and assignees); `schedule` brings every `BACKLOG` descendant back;
  `cancel` cancels every open descendant. `done` and `reopen` never cascade.
  Every open descendant of a `BACKLOG` task is `BACKLOG`.
- **Hold:** a claimed or assigned task holds its subtree: nothing beneath it is
  ready, and `claim` beneath it is refused.
- **Authorization:** a live or unknown claim admits only its claimant (same
  actor, same session when one is recorded; a claim without a session admits
  the same actor from any session); an orphaned claim admits anyone the
  other rules allow; an unclaimed assigned task admits its assignee and the
  assignees of its ancestors.
- **Liveness:** `live` (session heartbeat within `session_timeout_minutes`, not
  ended), `orphaned` (older, or ended by `session-end`), `unknown` (no session,
  or no heartbeat file here). Every command run with a session, reads included,
  touches its heartbeat file in each tree it spans and removes stale or ended
  files no claim names from the local registry; `.locks/` is git-ignored.
- **`--force`** overrides authorization, the start gate, a live or unknown
  claim, a hold — never the finish gate, the `state.md` rules, a resolved
  parent, a `BACKLOG` ancestor, a cycle, a reserved path or a message. The log
  records every forced transition; a forced `state` write is not logged.

## Workspace files

| File        | Concern                                          | Mode                                     |
| ----------- | ------------------------------------------------ | ---------------------------------------- |
| `task.md`   | definition and acceptance; later inputs in Notes | body in place; frontmatter machine-owned |
| `state.md`  | where the work is: done, verified, open, next    | replaced in full through `tasks state`   |
| `design.md` | decisions and why; rejected alternatives         | edited in place                          |
| `plan.md`   | steps, files, verification                       | edited in place                          |
| `log.md`    | what happened, who, when                         | append-only, by the CLI                  |

`log.md` entries are a heading and free text:

```
## 2026-09-21T16:40:12Z agent s:7f3a
pause: IN_PROGRESS → PAUSED
Kernel tests green (623/0); awaiting review of the CLI rendering.
```

`heading = "## " timestamp " " actor [" via " operator] [" s:" session]`. The
first line names the command (`claim: TODO → IN_PROGRESS`,
`handoff alice: IN_PROGRESS → PAUSED`, `assign: alice`, `unassign`,
`priority: high`, `new: TODO`, `dep add: …`, `move: old → new`); a task a
cascade reached gets `<command> with <parent>: <from> → <to>`; a forced entry
carries `(forced)` at the end of that first line; a transition past a claim that
is not the caller's — a takeover, a cascade over an orphaned claim, a forced
transition over a live one — adds `supersedes <actor> s:<session>, last seen
<time>`; the task a cascade was ordered on adds `reached: <ids>`; the message
comes last; a gate edit or a move past a claim adds `over the claim of <actor>
s:<session> (<liveness>, last seen <time>)`. Entries are never edited; merge conflicts are resolved by keeping both
entries in time order. A commit made for the task is named in an entry's text as
`commit <hash> on <branch>` (with the repository when it is not this one), in
the closing message or a `tasks log` entry, so `tasks log --since` and a grep
find it. The log is history, never a channel: an input for whoever works on the
task next goes under `## Notes` of `task.md` through `tasks note <task> "<text>"`,
which appends `- <date>, <actor>: <text>` there and logs `note`; it is the one
edit of a body the CLI makes, needs no authorization and is no transition.

## `config.yml`

```yaml
version: 2
scope: auth-rework # default scope for list, ready, tree and claim --next; keeps them to this tree
session_timeout_minutes: 30 # heartbeat age after which a claim is orphaned
archive_resolved_after_days: 30 # resolved this long ago and still live: reported
actors: # who tasks may be assigned to, each with a line on who they are
  alice: maintainer; approves plans and does releases
  agent: the coding agent
  codex: { type: agent, description: a second coding agent }
docs: # where the project's documentation lives; brought up to date before done
  engineering: docs/engineering
  api: ../api-docs
projects: # sibling trees by alias, relative to the project root
  backend: ../backend
```

`version` is required; every other key is optional. Unknown keys are rejected
(exit `2`): v1's `active_phase` is `scope` now, and `statuses`, `roles` and
`transitions` are gone. A tree without `version: 2` is a v1 tree, refused by
every command that opens it; `tasks migrate` upgrades it (`--dry-run` previews), and `skill install` and
`hooks install` only write beside it.

Once `actors` lists anyone, `assign`, `handoff`, `new --assign` and `--as` (on a
command that opens the tree) refuse other names (exit `2`; `details.actors` lists
the roster, `details.file` the `config.yml` to extend — the one of the tree that
holds the task, the local one for `--as`), an unlisted acting identity is reported
on stderr (not under `--json`) on reads and refused on writes (exit `2`; a person
names themselves once with `git config --global tasks.actor <name>`), and `validate`
warns `unknown-actor` for an open task whose assignee or claimant is unlisted.
`tasks actors` shows the roster with each actor's open tasks, and
`tasks init --actors [<names>]` writes the key from the start. Each actor has a
`type`, `person` or `agent`: a bare entry is a person, the name `agent` an agent,
a mapping (`codex: { type: agent, description: … }`) says so itself; an unlisted
name is a person, `agent` excepted. A person's `pause` keeps the task for them
(assignee set, `pause tom: IN_PROGRESS → PAUSED` in the log); an agent's leaves
it free.

`docs` names where the project's documentation lives: name → path relative to
the project root, a directory or a file, inside the repository or beside it
(`../api-docs`); an absolute path is refused like a project path. `tasks resume`
reports the locations of the tree that holds the task, each with whether it is
present on this machine, `tasks validate` warns `docs-missing` for an absent
one, and before `done` you bring the listed documentation that describes what
the task changed up to date and say so in the message (see `SKILL.md`).

## References

```
reference    = path | project-path ":" path
path         = segment *("/" segment)        segment = ^[a-z0-9][a-z0-9-]*$
```

Split on the **last** colon. `project-path` is relative to the project root of
the tree that stores the reference, never absolute. On the command line a
reference is a full id, an unambiguous suffix, or `alias:path` for a project
listed in `config.yml`; it is stored in full, with the alias translated into the
relative path, and `show`, `resume` and `dep list` print it back in the alias
form. Writes reach only listed trees; a tree reached by a bare path is read-only.

## Gate reasons

An unsatisfied reference carries exactly one reason, and every one blocks:

| Reason                | The target…                                             |
| --------------------- | ------------------------------------------------------- |
| `not-done`            | is live and open                                        |
| `cancelled`           | is `CANCELLED` — never satisfies `depends_on`: stranded |
| `missing`             | does not exist (also a reference that does not parse)   |
| `archived`            | exists only under `.archive/`                           |
| `malformed`           | has a `task.md` that does not parse                     |
| `unresolved-project`  | is in a project path that leads to no tree              |
| `not-checked-out`     | is in a listed project absent on this machine           |
| `unsupported-version` | is in a v1 tree or one of an unsupported version        |

`dep add` / `after add` refuse a self-reference, a missing task, the task's own
ancestor and a reference that would close a cycle.

## `tasks validate` findings

Errors (exit `4`): `malformed`, `unknown-status`, `unknown-priority`,
`claim-fields`, `malformed-ref`, `cycle`, `ancestor-dependency`,
`resolved-with-open-descendant`, `backlog-invariant`, `archived-path-conflict`,
`duplicate-id`, `log-conflict-markers`.

Warnings (exit `0`): `paused-without-state`, `todo-with-state`,
`unsatisfiable-ref`, `claim-liveness`, `unknown-key`, `unknown-actor`,
`project-unavailable`, `duplicate-project`, `docs-missing`,
`resolved-unarchived`, `index-stale`.

`--fix` only regenerates `index.md`; every other finding needs a person's
intent. Exit `0` with `{"ok": true, "findings": []}` means the tree is clean.

## Error shape

Under `--json`, errors go to stderr, and nothing else does:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "auth-rework/token-schema is IN_PROGRESS and has no state.md; write it before pausing (`tasks state auth-rework/token-schema` reads it from stdin).",
    "details": { "id": "auth-rework/token-schema", "kind": "missing-state" }
  }
}
```

`code` is `USAGE` (exit 2), `NOT_FOUND` (3), `CONFLICT` (4) or `INTERNAL` (1).
`details` carries the facts — `from`/`to`/`allowed`, `claimed_by`/
`claimed_session`/`liveness`, `blocked_by`, `open_children`, `ancestor`,
`claims`, `candidates`, `dependents` — and conflicts name the refusal in
`details.kind`: `illegal-transition`, `authorization`, `already-claimed`,
`start-gate`, `finish-gate`, `held`, `backlog-ancestor`, `resolved-ancestor`,
`cascade-claim`, `missing-state`, `present-state`, `not-assigned`, `cycle`,
`ancestor`, `exists`, `reserved`, `path-blocked`, `dependents`, `locked` (a busy
tree lock), `editor`, and others; an option the parser refuses carries `parser`.
Prefer `details` over parsing `message`, which is written for people and may
change.
