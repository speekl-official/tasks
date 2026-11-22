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
allowed-tools: Bash(tasks:*) Bash(TASKS_ACTOR=agent tasks:*) Bash(npx @speekl/tasks:*) Bash(TASKS_ACTOR=agent npx @speekl/tasks:*) Bash(uuidgen) Bash(echo $TASKS_SESSION) Bash(echo $TASKS_ACTOR)
---

Tasks live in `.tasks/` (convention v2): every task is a directory whose
`task.md` holds the definition. Its id is its path, `auth-rework/token-schema`; a
task inside another task is a part of the parent's deliverable. The `tasks` CLI
owns the frontmatter and enforces the rules below. The markdown body of
`task.md`, `design.md` and `plan.md` are yours to edit; `state.md` is written
through `tasks state`; `log.md` is appended by the CLI.

## Before anything else

With the harness hooks your tasks are already in your context, headed `Your
tasks`: the hook ran the entry's `mine` when the session started, and runs it
again after a resume, a clear or a compaction. **Do not run it again** for the
tree, actor and session that produced it; a tree a person points you at with
`-C <dir>` gets its own `mine`. Without the hooks — nothing headed `Your tasks`
in your context — set your name and session token first (next section), then
run it yourself:

```sh
TASKS_ACTOR=agent tasks mine --json --fields id,title,yours,situation,liveness,effective_priority,last_entry --session <token>
```

- Exit `3`, no `.tasks/` found: the project is not set up. **Ask before running
  `tasks init`** — creating a tree is the person's decision — and ask whom to
  list as actors: `tasks init --actors <person>,agent` writes the roster at
  once; without the flag it stays off until someone uncomments `actors:` in
  `config.yml`. A person whose git name has spaces names themselves once with
  `git config --global tasks.actor <name>`; with a roster on, a write under a
  name it lacks is refused.
- Exit `2` with `details.version` `1`, a v1 tree: tell the person; the one-time
  `tasks migrate` is theirs to run (`tasks migrate --dry-run` previews it).
- If `tasks` is not on PATH, use `npx @speekl/tasks` in its place everywhere.
- In a git worktree your commands reach the main checkout's tree by themselves;
  `-C <dir>` only when a person points you at a tree elsewhere.

## Your name and session token

Your name is `TASKS_ACTOR` when the harness set it, else **`agent`**; a team
that named its agent otherwise (an actor of `type: agent` in `tasks actors`)
tells you so. `tasks actors` is for choosing a person, not for finding your own
name. You act with **one session token on every command** of this session: a
claim without one has unknown liveness, so nobody takes it over without force,
and your own next session can only `pause` it as the same actor and claim it
again. Subagents use the same name and token.

- **With the harness hooks**, `TASKS_SESSION` and `TASKS_ACTOR` are already set
  (`echo $TASKS_SESSION`), you pass nothing, and every tool call heartbeats.
- **Without them**, generate a token once (`uuidgen`, or `date +%s`; it must
  match `^[A-Za-z0-9][A-Za-z0-9._@+-]*$`, which an ISO timestamp's colons fail),
  then prefix every command with
  `TASKS_ACTOR=agent` (unless it is already set: `echo $TASKS_ACTOR`) and
  pass `--session <token>` to it:
  `TASKS_ACTOR=agent tasks claim --next --session <token>`. Shell variables may
  not survive between tool calls, so prefer the prefix and the flag to an
  `export`. Never `--as agent`: `--as` records the person as the operator.
  Without the name you act under the person's git identity, and nothing tells
  your work from theirs. A long stretch without any `tasks` command — reading
  code, running tests — lets your claim go `orphaned` for everyone else after
  `session_timeout_minutes` (30 by default), and another agent may take it:
  run `tasks heartbeat` in such a stretch, or any command (a `state` write
  counts).

## Entry

1. **Your tasks** (`mine`, above), first. In this order: a task claimed by this session —
   continue it; then, among the tasks claimed by you in older sessions that are
   now `orphaned` and the tasks assigned to you (your inbox), the one with the
   highest effective priority — at equal priority finish your orphan before
   starting inbox work — unless a person's instruction names what comes first:
   in the conversation, under `## Notes`, or in a candidate's `last_entry` (an
   `assign -m`, a `note`), so read the candidates' last entries before choosing
   or claiming, and put input the work needs under `## Notes` (`tasks note`)
   before the claim, which writes a new last entry; only then new work. Take over an
   orphan with an ordinary `tasks claim <task>`, one at a time, and only what
   you will work on now: the others stay orphaned, which is no breakage. A task
   held by another **live** session is not yours. A claim of **unknown**
   liveness is reported to the person, never forced. Another actor's orphaned
   claim is taken over only on the person's instruction. Each row's `yours`
   names its case: `this-session`, `orphaned`, `elsewhere` (another live
   session, or unknown liveness), `inbox`; `ready --json` carries it too. What
   was left for you is in a task's files: `## Notes` of `task.md`, `design.md`,
   `state.md`.
2. **Claim before working, read before changing.** Your own orphan: `claim` it
   first (that restores your hold), then `resume`. New work: `tasks claim --next`
   (the first task of your ready set, in one step) and then `resume`, or
   `resume` the candidates and `tasks claim <task>` by id when choosing. A
   conflict (exit `4`) means another agent was first: take the next ready task.
3. **`tasks resume <task>`** is the reading of `task.md` and `state.md`: it
   prints the definition, the gates and ownership, the ancestors with their
   workspace files, the children with their status and situation, the docs
   locations, `state.md` in full and the last log entry (`--json`: the same as
   `body`, `state` and the full objects). Do not read those two files again.
   Then read `design.md` and `plan.md` where the workspace lists them, and for
   each ancestor as far as needed its `task.md`, `design.md` and `plan.md` — an
   epic's design and plan live on the epic. `--fields` on `resume` trims the
   children too: keep `status`, `assignee`, `claimed_by`, `blocked_by`,
   `finishes_after`, `held_by` and `referenced_by` beside `body`, `state`,
   `ancestors`, `child_tasks`, `workspace`, `docs` and `last_entry`, or the
   gates and the holder disappear from view. **Never read `log.md` on entry**;
   the last entry, the last activity, is in the `resume` output. A person's
   text that reached you only there goes under `## Notes` (`tasks note`).
4. **Listed projects you cannot see** — `not shown` in an overview's footer,
   `unavailable` in the JSON: a v1 tree, a repository not checked out here — are
   a person's to migrate or check out. Say so once in your report and go on.

## During work

- **Never hand-edit frontmatter**; every field has a command. **Never `mv`** a
  task directory; use `tasks move`.
- Write `state.md` through **`tasks state <task> < file`** (or a heredoc), so
  the write is fenced like a transition. Recommended sections: **Done** (with
  the commits that carry it), **Verified**, **Open**, **Next**. Keep it a short
  resume point — a screen, about twenty lines: results and the commits that
  carry them, not the steps that produced them; the history is `log.md`. Each
  write replaces it whole; never let it grow turn by turn.
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
  `state.md` updated — rewritten as the short resume point above, not extended
  by the turn's steps. The status stays `IN_PROGRESS` between turns.

## Exit

- **A turn is not a session.** A turn ends with the claim kept and `state.md`
  fresh whenever you expect to continue in this conversation — waiting for the
  person's answer included. The session ends with `pause`, `handoff` or `done`:
  the conversation closes, the harness stops you, or the task passes to someone.
  A task that cannot move without a person's decision is a `handoff` to them,
  the question in the message and under `## Notes`. Not sure you will be back?
  `pause`: your pause frees the task; an orphan is what to avoid.
- End work on a task deliberately with **`pause`**, **`handoff`** or **`done`**,
  each with `-m`, the history line; the resume point is `state.md`. Never end a
  session deliberately with a task `IN_PROGRESS`. Your `pause` releases the task
  to whoever is free, first in `ready`; a person's `pause` keeps the task for
  them (`waiting for tom`), so such a task is not yours to take.
- An input for whoever works next — a decision, a fact, a link — goes under
  `## Notes` of `task.md`: `tasks note <task> "<text>"`, dated and attributed,
  logged. A message alone is history; the next entry displaces it.
- `pause` and `handoff` are refused without a `state.md`; write it first.
  `release` is only for a claim that produced nothing.
- `state.md` names, under _Open_, every uncommitted file and branch you leave.
- **Commits in the log.** Name every commit you made for the task in its log
  before you stop: in the `pause`, `handoff` or `done` message, or earlier with
  `tasks log <task> "commit <hash> on <branch>: <what>"` when a turn produced
  one; add the repository when it is not this one. Put the task's id in the
  commit message where the project's commit convention allows it (a
  `Task: <id>` trailer, or in the subject), so the link holds both ways.
- **Documentation before `done`.** `tasks resume --json` lists where the
  project's documentation lives under `docs` (name, path, `present`). Bring
  the listed documents that describe what you changed up to date, and promote
  knowledge that must outlive the task there; the task directory is working
  memory. Only within the task's scope: never a general revision, never
  task-level detail. The `done` message says what changed in the docs, or that
  nothing needed to. A location with `present: false` is named in the message
  instead of updated; a change in another repository that has not landed is
  named in the message too, and stays under _Open_ in `state.md` with its branch
  while the task is open.
- Project state lives only in the tree, never in your private memory.

The examples below assume the hooks; without them, prefix `TASKS_ACTOR=agent`
and add `--session <token>` as above.

```sh
tasks state <task> <<'MD'
## Done
- Parser implemented; unit tests green (41/0); commit 4f1c2e on parser.
## Verified
- Ran against the fixtures in test/data.
## Open
- src/parse.ts uncommitted on branch parser.
## Next
- Wire the parser into the import command.
MD
tasks pause <task> -m "Parser done and tested, commit 4f1c2e on parser; the import command is next."
tasks handoff <task> alice -m "Ready for review: design.md has both options."
tasks done <task> -m "Merged: commit abc123 on main; docs: engineering/auth.md updated."
```

## Creating tasks

```sh
tasks new <path> <title…> [--backlog] [--assign <actor>] [--priority <level>]
tasks dep add <task> <ref>…        # start gate: must be DONE before claim or done
tasks after add <task> <ref>…      # finish gate joins beyond the task's children
```

Groups on the path are created on demand. Then write the body in `task.md`
under the `path` `--json` returns (the task's directory): `## Description`,
`## Acceptance criteria`, `## Notes`. A task
whose body is empty is a reminder, not a task — write enough that a different
agent arriving cold can do the work without asking. Prefer several small
dependent tasks over one task with a long checklist.

## Commands

Global options: `-C <dir>` (the tree of another checkout), `--as <actor>`,
`--session <token>`. Every command that prints takes `--json`. `<task>` is a
full path, an unambiguous suffix, or `alias:path` in a listed project. What a
command does, and every flag with its values: `tasks <command> --help`, or the
command table in `${CLAUDE_SKILL_DIR}/reference/commands.md`.

- **Read:** `mine [--local]`;
  `ready [--scope <path>] [--all] [--local] [--priority <level>]`;
  `list [--<situation>…] [--active] [--priority <level>] [--updated-before <when>] [--created-since <when>] [--sort created|updated] [--reverse] [--all] [--top] [--depth <n>]`
  (the situations: `--blocked`, `--waiting`, `--parked`, …);
  `tree [--sort created|updated] [--reverse] [--top] [--depth <n>]`;
  `show <task> [--archived]`; `resume <task>`; `actors`;
  `log <task> [--since <when>] [--actor <actor>]`;
  `log --since <when> [--actor <actor>] [--scope <path>] [--archived]`;
  `dep list <task>`; `after list <task>`; `validate [--fix]`.
- **Work a task:** `claim <task>` / `claim --next`; `state <task> [--edit]`;
  `log <task> "<text>"`; `note <task> "<text>"`; `pause <task> -m <text>`;
  `handoff <task> <actor> -m <text>`; `done <task> -m <text>`; `release <task>`.
- **Shape the tree:**
  `new <path> <title…> [--backlog] [--assign <actor>] [--priority <level>]`;
  `move <source> <destination>`; `dep add|rm <task> <ref>…`;
  `after add|rm <task> <ref>…`; `priority <task> urgent|high|normal|low`;
  `assign <task> <actor>` / `unassign <task>` (an assigned task holds its
  subtree); `schedule <task>` / `defer <task>` (onto / off the plan, with the
  subtree); `cancel <task> -m <text>` (with the subtree) /
  `reopen <task> -m <text>`.
- **Housekeeping:** `archive [<task>] [--resolved-before <when>]`,
  `restore <path>`, `purge <path>`, `delete <task>` (a never-worked task only);
  `reindex`; `migrate [--dry-run]`; `init [--actors [<names>]]` and
  `hooks install [--actor <name>]` (ask first); `skill install --force`.
- **Run by the harness:** `heartbeat`, `session-check`, `session-end`.

`--force` overrides authorization and, per command, the start gate, a live
claim or a hold — never the finish gate or the `state.md` rules — and the log
records every forced transition (a forced `state` write is not logged). **Use it
only on a person's explicit instruction.**

## Machine-readable contract

Use `--json` whenever you parse; the human output is not stable.

- Success goes to **stdout**. Under `--json`, errors go to **stderr** as
  `{"error": {"code", "message", "details"}}` and nothing else does;
  `details.kind` names the refusal (`parser` for an option the parser refused).
- Exit codes: `0` success, `1` internal, `2` usage, `3` not found, `4`
  conflict. **Branch on the code and `details`, never on message text.**
- **An empty result is success:** `tasks ready` with nothing to do exits `0`
  with `"count": 0`. Only `claim --next` turns it into exit `3`.
- In a terminal an overview fits its width and cuts long titles with `…`;
  piped output and `--json` are never cut. Read `--json` when the text matters.
- Task objects carry the frontmatter (`status`, `priority`, `depends_on`,
  `finishes_after`, `assignee`, `claimed_by`, `claimed_at`, `claimed_session`,
  `created`, `updated`), `id`, `name`, `parent`, `project`, `title`, `path`, and
  the derived `situation`, `blocked_by`, `ready`, `effective_priority`,
  `held_by`, `started`, `children`, `active`, `waiting_for`, `closable`,
  `liveness`, `last_seen`, `yours`, `last_entry`. Overviews return
  `{scope, projects, count, tasks, malformed, unavailable}`. `show` adds `body`,
  `workspace`, `referenced_by`; `resume` adds those and `ancestors`,
  `child_tasks`, `state`, `docs`.
- Ask for the keys you need: `--fields id,situation,yours,title,last_entry`
  on any command that returns task objects (`mine`, `ready`, `list`, `tree`,
  `show`, `resume`, `new`, `note`, `restore`, `claim` and the other
  transitions, `dep`/`after add` and `rm`). The names are the task object's
  keys; a name no document has is exit `2`.
- `session-check` exits `4` with `{"ok": false, "violations": [...]}` on stdout
  when a task of this session has no `state.md`.

## When something looks wrong

Run `tasks validate --json` before hand-repairing anything. A conflict means
someone else was first, or a person decided — re-read with `tasks resume`.

| `details.kind`                     | What to do                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `missing-state`                    | `tasks state <task>`, then `pause` or `handoff` again.                           |
| `present-state`                    | The claim produced work: `pause` it, do not `release`.                           |
| `authorization`, `already-claimed` | Not yours, or already yours: check `tasks mine`; take another task.              |
| `start-gate`                       | `tasks dep list <task>`; the dependency is not `DONE`.                           |
| `finish-gate`                      | Resolve the open children or `finishes_after` tasks first.                       |
| `held`                             | An ancestor's plan is being written or awaits approval: wait.                    |
| `backlog-ancestor`                 | The epic is unscheduled; ask the person before `tasks schedule` on it.           |
| `illegal-transition`               | `details.allowed` lists the statuses the command applies to.                     |
| `cycle`, `ancestor`                | The reference would deadlock; model it differently.                              |
| `cascade-claim`                    | A live claim beneath that is not yours: wait, or ask the person.                 |
| `resolved-ancestor`                | The parent is resolved: `tasks reopen <parent> -m` first, or model it elsewhere. |

Never `--force` on your own initiative, never hand-edit frontmatter, never `mv`
a task directory. A task shown `blocked by X (cancelled)` is stranded: a person
decides whether to cancel it, drop the reference, or point it elsewhere.

## Deeper reference

The command table — every command with its flags and what it does — is
`${CLAUDE_SKILL_DIR}/reference/commands.md`; `tasks <command> --help` says the
same for one command. For the file layout, the `task.md` fields and their
canonical form, the workspace files, `config.yml`, the reference grammar, gate
reasons, situations, validation kinds and the error shape, read
`${CLAUDE_SKILL_DIR}/reference/convention.md`. Load either only when you need
it: a flag you do not know, a file to hand-author, the configuration, a finding
to interpret.
