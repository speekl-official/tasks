---
name: tasks
description: >-
  Read and update persistent, git-versioned tasks in a repo's .tasks/ directory
  through the `tasks` CLI, and leave a resume point for the next session. Use
  when work spans multiple sessions, when tasks depend on each other, or when
  several agents or people coordinate through git. Not for within-session
  checklists — use ordinary session todos for those.
when_to_use: >-
  Use whenever the repo has a .tasks/ directory, or the user asks what to work
  on next, to claim, pause, hand off or finish a task, what is blocked, to add
  or re-scope a task, or to plan work that must outlive this session.
allowed-tools: Bash(tasks:*) Bash(TASKS_ACTOR=agent tasks:*) Bash(npx @speekl/tasks:*)
---

Tasks live in `.tasks/` (convention v2): every task is a directory whose
`task.md` holds the definition. Its id is its path, `auth-rework/token-schema`; a
task inside another task is a part of the parent's deliverable. The `tasks` CLI
owns the frontmatter and enforces the rules below. The markdown body of
`task.md`, `design.md` and `plan.md` are yours to edit; `state.md` is written
through `tasks state`; `log.md` is appended by the CLI.

## Before anything else

```sh
tasks mine --json
```

- Exit `3`, no `.tasks/` found: the project is not set up. **Ask before running
  `tasks init`** — creating a tree is the person's decision — and ask whom to
  list as actors: `tasks init --actors <person>,agent` writes the roster at
  once; without the flag it stays off until someone uncomments `actors:` in
  `config.yml`.
- Exit `2`, "a .tasks v1 tree": tell the person; the one-time `tasks migrate` is
  theirs to run.
- If `tasks` is not on PATH, use `npx @speekl/tasks` in its place everywhere.

## Your name and session token

You act as **`agent`** (unless `tasks actors` lists another name for the
agent) with **one session token on every command** of this session; a claim
without one cannot be told from live work and is recovered only by force.
Subagents use the same name and token.

- **With the harness hooks**, `TASKS_SESSION` and `TASKS_ACTOR` are already set
  (`echo $TASKS_SESSION`), and you pass nothing.
- **Without them**, generate a token once (`uuidgen`, or a timestamp; it must
  match `^[A-Za-z0-9][A-Za-z0-9._@+-]*$`), then prefix every command with
  `TASKS_ACTOR=agent` (unless it is already set: `echo $TASKS_ACTOR`) and
  pass `--session <token>` to it:
  `TASKS_ACTOR=agent tasks claim --next --session <token>`. Shell variables may
  not survive between tool calls, so prefer the prefix and the flag to an
  `export`. Never `--as agent`: `--as` records the person as the operator.
  Without the name you act under the person's git identity, and nothing tells
  your work from theirs.

## Entry

1. **`tasks mine`.** Continue a task claimed by this session. Take over a task
   claimed by you in an older session once it is `orphaned` (an ordinary
   `tasks claim <task>`) before taking new work. A task held by another
   **live** session is not yours. A claim of **unknown** liveness is reported to
   the person, never forced. Another actor's orphaned claim is taken over only
   on the person's instruction. A task merely assigned to you is your inbox; its
   last log entry is the note left for you.
2. **`tasks resume <task>`**, then read, in order: `task.md`, `state.md`,
   `design.md`, `plan.md`, then for each ancestor as far as needed its
   `task.md`, `design.md` and `plan.md` — an epic's design and plan live on the
   epic. **Never read `log.md` on entry**; its last entry is already in the
   `resume` output.
3. **Claim before working**, not after: `tasks claim --next` (the first task of
   your ready set, claimed in one step) or `tasks claim <task>`. A conflict
   (exit `4`) means another agent was first: take the next ready task.

## During work

- **Never hand-edit frontmatter**; every field has a command. **Never `mv`** a
  task directory; use `tasks move`.
- Write `state.md` through **`tasks state <task> < file`** (or a heredoc), so
  the write is fenced like a transition. Recommended sections: **Done**,
  **Verified**, **Open**, **Next**.
- A clarification of the statement changes `Description` / `Acceptance
criteria` in place; an input received after the start goes to `## Notes`; a
  decision goes to `design.md`; a change of plan goes to `plan.md`.
- **Children are parts of the deliverable, never phases.** Never create a child
  for planning, review or verification: the plan is `plan.md`, the review is a
  `handoff`.
- A follow-up that is not part of the deliverable becomes a separate task
  **outside** the parent: `tasks new <path> "<title>" --backlog`, linking to the
  context in its body.
- A step a person must take — review, approval, deploy — is a `handoff` to them
  when it concerns this task, and a separate task with `--assign <them>` only
  when other tasks must depend on it. `tasks actors` says who they are and how
  they are named; a refused name is corrected, never added to `config.yml` on
  your own.
- A task with open children is **never cancelled, deferred or archived on your
  own initiative**: only on a person's instruction, quoted in the message.
- **`--as <actor>` only on an explicit instruction** from that actor in this
  session, with the instruction quoted in `-m`. Never to satisfy an assignee
  rule on your own.
- **Freshness rule:** every turn in which the work progressed ends with
  `state.md` updated. The status stays `IN_PROGRESS` between turns.

## Exit

- End work on a task deliberately with **`pause`**, **`handoff`** or **`done`**,
  each with `-m` — the closing note the next reader sees. Never end a session
  deliberately with a task `IN_PROGRESS`.
- `pause` and `handoff` are refused without a `state.md`; write it first.
  `release` is only for a claim that produced nothing.
- `state.md` names, under _Open_, every uncommitted file and branch you leave.
- Promote knowledge that must outlive the task into the project's documentation
  before `done`; the task directory is working memory.
- Project state lives only in the tree, never in your private memory.

```sh
tasks state <task> <<'MD'
## Done
- Parser implemented; unit tests green (41/0).
## Verified
- Ran against the fixtures in test/data.
## Open
- src/parse.ts uncommitted on branch parser.
## Next
- Wire the parser into the import command.
MD
tasks pause <task> -m "Parser done and tested; the import command is next."
tasks handoff <task> alice -m "Ready for review: design.md has both options."
tasks done <task> -m "Merged as abc123; docs updated."
```

## Creating tasks

```sh
tasks new <path> <title…> [--backlog] [--assign <actor>] [--priority <level>]
tasks dep add <task> <ref>…        # start gate: must be DONE before claim or done
tasks after add <task> <ref>…      # finish gate joins beyond the task's children
```

Groups on the path are created on demand. Then write the body at the `path`
`--json` returns: `## Description`, `## Acceptance criteria`, `## Notes`. A task
whose body is empty is a reminder, not a task — write enough that a different
agent arriving cold can do the work without asking. Prefer several small
dependent tasks over one task with a long checklist.

## Command table

Global options: `-C <dir>` (the tree of another checkout), `--as <actor>`,
`--session <token>`. Every command that prints takes `--json`. `<task>` is a
full path, an unambiguous suffix, or `alias:path` in a listed project.

| Command                                                           | Purpose                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tasks mine [--local]`                                            | Your claims (this session's first), then your inbox.                                                         |
| `tasks actors`                                                    | Who tasks may be assigned to, with their open tasks.                                                         |
| `tasks resume <task>`                                             | Ancestors, children, `state.md`, last log entry.                                                             |
| `tasks show <task>`                                               | Fields, derived conditions, references, body.                                                                |
| `tasks ready [--scope <path>] [--all] [--local]`                  | What you may take now, best first.                                                                           |
| `tasks list [--<situation>…] [--all]` / `tasks tree`              | Open tasks by situation; `--blocked`, `--waiting`, `--parked`, …                                             |
| `tasks claim <task>` / `tasks claim --next`                       | Start working; takes over an orphaned claim.                                                                 |
| `tasks state <task> [--edit]`                                     | Replace `state.md` from stdin.                                                                               |
| `tasks pause <task> -m <text>`                                    | Stop; needs `state.md`.                                                                                      |
| `tasks handoff <task> <actor> -m <text>`                          | Pause and assign to whoever must review or decide.                                                           |
| `tasks done <task> -m <text>`                                     | Finish; refused while a child or `finishes_after` task is open.                                              |
| `tasks release <task>`                                            | Give back a claim that produced nothing.                                                                     |
| `tasks cancel <task> -m <text>` / `tasks reopen <task> -m <text>` | Cancel with the subtree; bring a closed task back.                                                           |
| `tasks schedule <task>` / `tasks defer <task>`                    | Onto / off the plan, with the subtree.                                                                       |
| `tasks assign <task> <actor>` / `tasks unassign <task>`           | Who the task waits on; an assigned task holds its subtree.                                                   |
| `tasks priority <task> <level>`                                   | `urgent`, `high`, `normal`, `low`.                                                                           |
| `tasks new <path> <title…>`                                       | Create a task.                                                                                               |
| `tasks dep add\|rm\|list` / `tasks after add\|rm\|list`           | Edit and inspect the gates.                                                                                  |
| `tasks move <source> <destination>`                               | Relocate a task or group, rewriting every reference.                                                         |
| `tasks log <task> "<text>"` / `tasks log --since 1d`              | Narrative entry; recent history across trees.                                                                |
| `tasks archive`, `restore`, `purge`, `delete`                     | Archive a resolved subtree (`--resolved-before 30d`: all older ones); undo; release a path; remove unworked. |
| `tasks session-check` / `heartbeat` / `session-end`               | Exit invariant; liveness (run by the harness).                                                               |
| `tasks validate [--fix]` / `tasks reindex`                        | Check the tree; regenerate `index.md`.                                                                       |
| `tasks init [--actors [<names>]]` / `tasks skill install`         | Scaffold a tree (ask first; `--actors` lists who tasks go to); refresh this skill.                           |
| `tasks hooks install [--actor <name>]`                            | Write the harness hooks into `.claude/settings.json` (ask first).                                            |

`--force` overrides authorization and, per command, the start gate, a live
claim or a hold — never the finish gate or the `state.md` rules — and the log
records it. **Use it only on a person's explicit instruction.**

## Machine-readable contract

Use `--json` whenever you parse; the human output is not stable.

- Success goes to **stdout**. Under `--json`, errors go to **stderr** as
  `{"error": {"code", "message", "details"}}`; `details.kind` names the refusal.
- Exit codes: `0` success, `1` internal, `2` usage, `3` not found, `4`
  conflict. **Branch on the code and `details`, never on message text.**
- **An empty result is success:** `tasks ready` with nothing to do exits `0`
  with `"count": 0`. Only `claim --next` turns it into exit `3`.
- Task objects carry the frontmatter (`status`, `priority`, `depends_on`,
  `finishes_after`, `assignee`, `claimed_by`, `claimed_at`, `claimed_session`,
  `created`, `updated`), `id`, `name`, `parent`, `project`, `title`, `path`, and
  the derived `situation`, `blocked_by`, `ready`, `held_by`, `children`,
  `waiting_for`, `liveness`, `last_seen`, `last_entry`. Overviews return
  `{scope, projects, count, tasks, malformed}`. `resume` adds `ancestors`,
  `child_tasks`, `workspace`, `state`.
- `session-check` exits `4` with `{"ok": false, "violations": [...]}` on stdout
  when a task of this session has no `state.md`.

## When something looks wrong

Run `tasks validate --json` before hand-repairing anything. A conflict means
someone else was first, or a person decided — re-read with `tasks resume`.

| `details.kind`                     | What to do                                                             |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `missing-state`                    | `tasks state <task>`, then `pause` or `handoff` again.                 |
| `present-state`                    | The claim produced work: `pause` it, do not `release`.                 |
| `authorization`, `already-claimed` | Not yours, or already yours: check `tasks mine`; take another task.    |
| `start-gate`                       | `tasks dep list <task>`; the dependency is not `DONE`.                 |
| `finish-gate`                      | Resolve the open children or `finishes_after` tasks first.             |
| `held`                             | An ancestor's plan is being written or awaits approval: wait.          |
| `backlog-ancestor`                 | The epic is unscheduled; ask the person before `tasks schedule` on it. |
| `illegal-transition`               | `details.allowed` lists the statuses the command applies to.           |
| `cycle`, `ancestor`                | The reference would deadlock; model it differently.                    |

Never `--force` on your own initiative, never hand-edit frontmatter, never `mv`
a task directory. A task shown `blocked by X (cancelled)` is stranded: a person
decides whether to cancel it, drop the reference, or point it elsewhere.

## Deeper reference

For the file layout, the `task.md` fields and their canonical form, the
workspace files, `config.yml`, the reference grammar, gate reasons, situations,
validation kinds and the error shape, read
`${CLAUDE_SKILL_DIR}/reference/convention.md`. Load it only when you need to
hand-author a file, change the configuration, or interpret a finding.
