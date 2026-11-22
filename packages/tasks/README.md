# @speekl/tasks

A local, git-versioned task manager for people and AI coding agents. Tasks live in
a `.tasks/` directory in your repository: every task is a directory with a
markdown manifest, `task.md`, and beside it the files the next session reads to
continue — readable by a human, parseable by an agent, versioned by git. No
server, no account, no network.

This package is the reference implementation of the
[`.tasks` convention v2](https://agenttasks.dev/docs/spec): a CLI that enforces
the rules that keep a tree trustworthy — a fixed lifecycle, gates that fail
safe, containment, sessions, and a resume point an agent cannot skip.

**Full documentation: [agenttasks.dev](https://agenttasks.dev)**

## Install

```sh
npm install -g @speekl/tasks
# or, without installing
npx @speekl/tasks --help
```

Either way the command it installs is `tasks`. Node 20 or newer is required.

## The loop

```sh
tasks init                                          # scaffold .tasks/, print your actor, install the agent skill
tasks new auth-rework "Rework authentication"       # an epic
tasks new auth-rework/token-schema "Design the token schema"
tasks new auth-rework/wire-refresh "Wire the refresh endpoint"
tasks dep add wire-refresh token-schema             # suffixes work; full paths are stored

tasks ready                                         # what you can take now, best first
tasks claim --next --session s1                     # take the first ready task
tasks state token-schema --session s1 < state.md    # save the resume point
tasks pause token-schema --session s1 -m "Claims table drafted; lifetime open."
tasks resume token-schema                           # what the next session reads
tasks claim token-schema --session s2
tasks done token-schema --session s2 -m "Schema agreed."
tasks validate                                      # check the tree
```

A task's id is its path under `.tasks/`. A task inside another task is a part of
its deliverable: the parent is done only when its children are resolved. Overviews
show one computed **situation** per task — `ready`, `blocked by X`,
`waiting for alice`, `open 1/2`, `working by agent` — instead of the stored status.

## Commands

Every command takes the global options `-C, --dir <dir>` (where to look for
`.tasks/`), `--as <actor>` and `--session <token>`, before or after the command
name. Every command that prints something takes `--json`. A `<task>` is a full
path, an unambiguous suffix of one, or `alias:path` in a listed project.

| Command                                                                                                                                                                                                          | Purpose                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tasks init [--force] [--no-skill] [--actors [<names>]]`                                                                                                                                                         | Scaffold `.tasks/`, print the resolved actor, install the agent skill; `--actors` writes the roster.                                                                                                                                                                                 |
| `tasks skill install [--force]`                                                                                                                                                                                  | Install or refresh the agent skill in `.claude/skills/tasks/`.                                                                                                                                                                                                                       |
| `tasks hooks install [--actor <name>] [--force]`                                                                                                                                                                 | Write the Claude Code harness hooks into `.claude/settings.json`; they need `jq`.                                                                                                                                                                                                    |
| `tasks show <task> [--archived]`                                                                                                                                                                                 | The task: fields, derived conditions, references, workspace files, body; `--archived` reads one from the archive.                                                                                                                                                                    |
| `tasks resume <task>`                                                                                                                                                                                            | Everything the next session reads: ancestors, children, `state.md`, last log entry, docs locations; the JSON adds the definition.                                                                                                                                                    |
| `tasks ready [--scope <path>] [--all] [--local] [--priority <level>]`                                                                                                                                            | What you may take now: effective priority, then paused before todo, then oldest; `--priority <level>` keeps that level and above.                                                                                                                                                    |
| `tasks mine [--local]`                                                                                                                                                                                           | Your claims, then the tasks assigned to you, each with its last log entry.                                                                                                                                                                                                           |
| `tasks actors [--local]`                                                                                                                                                                                         | Who is around: the listed actors with their open tasks, and the names in use the roster lacks.                                                                                                                                                                                       |
| `tasks list [--scope <path>] [--all] [--local] [--depth <n> \| --top] [--<situation>…] [--active] [--priority <level>] [--updated-before <when>] [--created-since <when>] [--sort created\|updated] [--reverse]` | Open tasks by situation; `--ready`, `--blocked`, `--waiting`, `--parked`, `--done`, … filter, `--active` by the label, `--priority <level>` narrows to that level and above, the time bounds likewise; `--sort` orders by a timestamp, newest first; `--top` is the top level alone. |
| `tasks tree [--scope <path>] [--all] [--local] [--depth <n> \| --top] [--resolved] [--sort created\|updated] [--reverse]`                                                                                        | Open tasks nested by containment, siblings that share a group or a project under one line naming it, with `finishes_after` joins; `--depth 2` stops at the children; `--sort` orders siblings by a timestamp.                                                                        |
| `tasks schedule <task>`                                                                                                                                                                                          | `BACKLOG` → `TODO`, or `PAUSED` when a `state.md` exists; reaches the subtree.                                                                                                                                                                                                       |
| `tasks defer <task>`                                                                                                                                                                                             | `TODO`/`PAUSED` → `BACKLOG`, with every open descendant.                                                                                                                                                                                                                             |
| `tasks claim <task>` / `tasks claim --next [--scope <path>] [--all] [--local]`                                                                                                                                   | Start working: → `IN_PROGRESS`; takes over an orphaned claim.                                                                                                                                                                                                                        |
| `tasks pause <task> -m <text>`                                                                                                                                                                                   | `IN_PROGRESS` → `PAUSED`; needs a `state.md`.                                                                                                                                                                                                                                        |
| `tasks release <task>`                                                                                                                                                                                           | `IN_PROGRESS` → `TODO`, for a claim that produced nothing.                                                                                                                                                                                                                           |
| `tasks done <task> -m <text>`                                                                                                                                                                                    | Close as done; refused while a child or a `finishes_after` task is open.                                                                                                                                                                                                             |
| `tasks cancel <task> -m <text>`                                                                                                                                                                                  | Cancel with every open descendant; lists the dependents it strands.                                                                                                                                                                                                                  |
| `tasks reopen <task> -m <text>`                                                                                                                                                                                  | `DONE`/`CANCELLED` → back to work.                                                                                                                                                                                                                                                   |
| `tasks handoff <task> <actor> -m <text>`                                                                                                                                                                         | Pause and assign to `<actor>`, whose review or decision it now waits for.                                                                                                                                                                                                            |
| `tasks assign <task> <actor>` / `tasks unassign <task>`                                                                                                                                                          | Set or clear who the task waits on; an assigned task holds its subtree.                                                                                                                                                                                                              |
| `tasks priority <task> <level>`                                                                                                                                                                                  | `urgent`, `high`, `normal` or `low`; descendants inherit the higher level.                                                                                                                                                                                                           |
| `tasks new <path> <title…> [--backlog] [--assign <actor>] [--priority <level>]`                                                                                                                                  | Create a task; groups on demand; an existing group becomes the task.                                                                                                                                                                                                                 |
| `tasks dep add\|rm\|list <task> [<ref>…]`                                                                                                                                                                        | Edit and inspect `depends_on`, the start gate.                                                                                                                                                                                                                                       |
| `tasks after add\|rm\|list <task> [<ref>…]`                                                                                                                                                                      | Edit and inspect `finishes_after`, joins of the finish gate.                                                                                                                                                                                                                         |
| `tasks move <source> <destination>`                                                                                                                                                                              | Relocate a task or group and rewrite every reference, here and in listed trees.                                                                                                                                                                                                      |
| `tasks state <task> [--edit]`                                                                                                                                                                                    | Replace `state.md` from stdin, or in `$VISUAL`/`$EDITOR`.                                                                                                                                                                                                                            |
| `tasks log <task> "<text>"` / `tasks log <task> [--since <when>] [--actor <actor>] [--archived]` / `tasks log --since <when> [--actor <actor>] [--scope <path>] [--local] [--archived]`                          | Append a narrative entry; read a task's history, since a time or one actor's; list entries since a time across trees, one actor's or one subtree's on request, the archive's too.                                                                                                    |
| `tasks note <task> "<text>"`                                                                                                                                                                                     | Leave an input for whoever works next under `## Notes` of `task.md`, dated and attributed; logged.                                                                                                                                                                                   |
| `tasks archive <task> [--force]`                                                                                                                                                                                 | Move a resolved subtree to `.archive/`; refused while open tasks reference it.                                                                                                                                                                                                       |
| `tasks archive --resolved-before [<when>]` / `--all-resolved`                                                                                                                                                    | Archive every resolved subtree older than a threshold (`30d`, a date), skipping and listing the ones open tasks reference.                                                                                                                                                           |
| `tasks restore <path>` / `tasks purge <path>`                                                                                                                                                                    | Bring an archive entry back; delete one for good and release its path.                                                                                                                                                                                                               |
| `tasks delete <task>`                                                                                                                                                                                            | Remove a never-worked task without archiving it.                                                                                                                                                                                                                                     |
| `tasks heartbeat` / `tasks session-end`                                                                                                                                                                          | Mark the session alive; mark it ended, orphaning its claims at once.                                                                                                                                                                                                                 |
| `tasks session-check`                                                                                                                                                                                            | Exit `4` when a task claimed by this session has no `state.md`.                                                                                                                                                                                                                      |
| `tasks validate [--fix]`                                                                                                                                                                                         | Check the tree; exit `4` on errors; `--fix` regenerates `index.md` only.                                                                                                                                                                                                             |
| `tasks reindex`                                                                                                                                                                                                  | Regenerate `.tasks/index.md`.                                                                                                                                                                                                                                                        |
| `tasks migrate [<alias>] [--dry-run] [--map OLD=NEW…] [--map-phase OLD=NEW…]`                                                                                                                                    | Upgrade a v1 tree, once; `--dry-run` previews it.                                                                                                                                                                                                                                    |

Transitions take `-m, --message <text>` — required by `pause`, `handoff`, `done`,
`cancel` and `reopen` — and `--force`, which overrides authorization and, where
the command allows, the start gate, a live claim or a hold; never the finish gate
or the `state.md` rules. Every force is recorded in the task's log. The full
reference is at
[agenttasks.dev/docs/reference/commands](https://agenttasks.dev/docs/reference/commands).

## The JSON contract

Exit codes, `--json` shapes and the `.tasks/` on-disk conventions are contract;
they change only in a major version.

- **Exit codes:** `0` success, `1` internal, `2` usage, `3` not found, `4`
  conflict. Branch on these, never on message text.
- **Streams:** success goes to stdout; under `--json`, an error goes to stderr as
  `{"error": {"code", "message", "details"}}` and nothing else does; `details.kind`
  names the refusal (`missing-state`, `start-gate`, `authorization`, `held`, …).
- **An empty result is success:** `tasks ready` with nothing available exits `0`
  with `"count": 0`.
- **Task objects** carry the frontmatter fields, `id`, `name`, `parent`,
  `project`, `title` and `path`, plus the derived conditions — `situation`,
  `blocked_by`, `ready`, `held_by`, `liveness`, `yours`, `last_entry`, … — on every
  reporting command. Overviews return
  `{scope, projects, count, tasks, malformed, unavailable}`.
- **Trim with `--fields`:** `tasks mine --json --fields id,situation,yours,title`
  keeps those keys of each task object, in that order, on every command that
  answers with task objects; the document without it is the contract.

```sh
tasks claim --next --json | jq -r .id
tasks validate --json | jq -e .ok
```

Every shape is documented at
[agenttasks.dev/docs/reference/json-contract](https://agenttasks.dev/docs/reference/json-contract).

## Configuration

`.tasks/config.yml` is required and declares the version:

```yaml
version: 2
scope: auth-rework # default scope for list, ready, tree and claim --next; keeps them to this tree
session_timeout_minutes: 30 # silence after which a claim is orphaned
archive_resolved_after_days: 30 # resolved this long ago and still live: validate reports them
actors: # who tasks may be assigned to; once any is listed, other names are refused
  alice: maintainer; approves plans and does releases
  agent: the coding agent
  codex: { type: agent, description: a second coding agent }
docs: # where the project's documentation lives; an agent brings it up to date before done
  engineering: docs/engineering
  api: ../api-docs
projects: # sibling trees, by alias
  backend: ../backend
```

Unknown keys are rejected. There are no statuses to configure: the lifecycle is
fixed — `BACKLOG`, `TODO`, `IN_PROGRESS`, `PAUSED`, `DONE`, `CANCELLED`.

### Actor and session

The **actor** heading every log entry is resolved from `--as`, then
`TASKS_ACTOR`, then `git config tasks.actor` (your name for the tool, set once with
`--global`), then `user.name`, then `user.email`, then the operating-system user; it
must match `^[A-Za-z0-9][A-Za-z0-9._@+-]*$`, and a git name with spaces is skipped with
a diagnostic that names the setting. `tasks init` prints the actor it
resolved. Give agents their own name with `TASKS_ACTOR`: `agent` by convention,
which the hooks export and the skill sets without them. List who tasks may be
assigned to under `actors:` — `assign`, `handoff`, `new --assign` and `--as` then
refuse other names, a write under your own unlisted name is refused too (reads only
warn), `validate` flags an unlisted assignee or claimant, and `tasks actors` shows who
is around. `tasks init --actors` writes the list from
the start; without the flag the scaffold carries your name and `agent`
commented out, ready to switch on. Each actor has a `type`, `person` or `agent`
(a bare entry is a person, the name `agent` an agent, `codex: { type: agent }`
says so itself): a person's `pause` keeps the task for them, an agent's leaves
it free for whoever is next.

The **session** is `--session <token>`, else `TASKS_SESSION`. A claim records it,
every command with a session keeps its heartbeat fresh, and a claim whose session
ended (`tasks session-end`) or went silent past the timeout can be taken over by
the next session. An agent uses one token for the whole session, on every
command.

## The agent skill

`tasks init` also installs an [agent skill](https://agentskills.io) into
`.claude/skills/tasks/`. It is what makes an agent reach for this CLI on its own:
it carries the agent protocol — the session token on every command, entry through
`mine` and `resume`, claim before working, the freshness rule for `state.md`, exit
through `pause`, `handoff` or `done` with the commits named in the log and the
listed documentation up to date — together with the command table and the JSON
contract.

Skip it with `tasks init --no-skill`. Add it to a project that predates it, or
refresh it after upgrading the CLI, with `tasks skill install --force`. Commit
`.claude/skills/tasks/` so every agent working in the repository gets it.

For Claude Code, `tasks hooks install` writes a hooks block into
`.claude/settings.json` that makes the protocol automatic — it exports the
session, keeps claims live and refuses to end a turn without a resume point. The
rest of the file is kept, and so is a tasks hook already there unless `--force`;
`--actor <name>` sets the actor the hooks act as (default `agent`). The hooks
need `jq` on `PATH`. Commit the file. See
[agenttasks.dev/docs/guides/harness](https://agenttasks.dev/docs/guides/harness).

## Upgrading from v1

A v1 tree — `.tasks/` without `version: 2` — is refused by every command that opens it
(`skill install` and `hooks install` only write beside it); `tasks migrate` upgrades it
once: phases become groups, `<phase>/<id>.md`
becomes `<phase>/<id>/task.md`, references become paths, and statuses are mapped
through the v1 roles. See
[agenttasks.dev/docs/guides/migration](https://agenttasks.dev/docs/guides/migration).

## Development

```sh
pnpm install
pnpm test          # vitest
pnpm check-types   # tsc --noEmit
pnpm build         # tsup -> dist/index.js
```

### Trying the CLI locally

**Link it globally** (recommended — gives you a real `tasks` command anywhere):

```sh
pnpm --filter @speekl/tasks build
cd packages/tasks && pnpm link --global
```

The link points at this working tree, so after any change just rebuild — no
re-linking needed:

```sh
pnpm --filter @speekl/tasks build   # or `pnpm --filter @speekl/tasks dev` to watch
tasks --version                     # picks up the new build immediately
```

Remove it when you're done:

```sh
cd packages/tasks && pnpm unlink --global
```

**Without linking**, run the built entry point directly:

```sh
node /path/to/tasks/packages/tasks/dist/index.js --help
```

**Test against a throwaway project** rather than a repo you care about — the CLI
writes real files:

```sh
cd "$(mktemp -d)"
tasks init
tasks new demo "Try it out"
tasks ready
```

**Verify packaging** before publishing — this shows exactly what ships:

```sh
cd packages/tasks && npm pack --dry-run
```

## License

MIT
