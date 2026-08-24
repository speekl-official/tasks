# @speekl/tasks

A local, git-versioned task manager for AI coding agents. Tasks live in a
`.tasks/` directory in your repo as markdown with YAML frontmatter — readable by
a human, parseable by an agent, and versioned by git. No server, no account, no
network.

It sits between "ad-hoc markdown files" and "a full external tracker": the file
convention stays simple enough to edit by hand, while the CLI enforces the
invariants that keep agents from corrupting state.

**Full documentation: [agenttasks.dev](https://agenttasks.dev)** — including the
normative spec for the `.tasks` convention, which this package implements.

## Install

```sh
npm install -g @speekl/tasks
# or, without installing
npx @speekl/tasks --help
```

Either way the command it installs is `tasks`. Node 20 or newer is required.

## Quick start

```sh
tasks init                                  # scaffold .tasks/ and install the agent skill
tasks new auth-rework "Design token schema" # create a task
tasks new auth-rework "Implement refresh"
tasks dep add implement-refresh design-token-schema

tasks ready                                 # what is unblocked right now
tasks claim design-token-schema             # take it
tasks status design-token-schema DONE       # finish it
tasks ready                                 # implement-refresh is now unblocked
```

## Commands

| Command                                   | Purpose                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `tasks init [--force]`                    | Scaffold `.tasks/` with config, README, and gitignore.                                 |
| `tasks new <phase> <name> [--id]`         | Create a task; the phase directory is auto-created.                                    |
| `tasks list [--phase] [--all] [--status]` | List tasks, filterable.                                                                |
| `tasks show <id>`                         | Print one task's metadata, dependencies, and body.                                     |
| `tasks ready [--phase] [--all]`           | Tasks that are unblocked and available to work on.                                     |
| `tasks claim <id> [--as] [--force]`       | Take ownership, recording who and when.                                                |
| `tasks release <id>`                      | Give a claimed task back to the ready pool.                                            |
| `tasks status <id> <STATUS>`              | Move a task through its lifecycle.                                                     |
| `tasks dep add\|rm\|list <id> …`          | Manage dependencies.                                                                   |
| `tasks move <id> <phase>`                 | Reassign a phase, relocating the file.                                                 |
| `tasks delete <id> [--force] [--purge]`   | Archive (default) or permanently remove.                                               |
| `tasks reindex`                           | Regenerate `_index.md`.                                                                |
| `tasks validate [--fix]`                  | Check tree integrity, including a stale `_index.md`; repair what is mechanically safe. |
| `tasks skill install [--force]`           | Install the agent skill into `.claude/skills/tasks/`.                                  |

Every command accepts `--json`.

## The agent skill

`tasks init` also installs an [agent skill](https://agentskills.io) into
`.claude/skills/tasks/`. It is what makes an agent reach for this CLI on its own
instead of inventing its own markdown convention: it documents when to use
persistent tasks over a session checklist, the claim-before-working loop, the
invariants below, and the JSON contract.

Skip it with `tasks init --no-skill`. Add it to a project that predates it, or
refresh it after upgrading the CLI, with:

```sh
tasks skill install [--force]
```

The skill is left alone on reinstall unless `--force`, so local edits survive.
Commit `.claude/skills/tasks/` so every agent working in the repo gets it.

## For agents

The contract is designed to be consumed programmatically:

- **`--json` on every command.** Successful output goes to stdout; under
  `--json`, errors go to stderr as `{"error": {"code", "message", "details"}}`.
- **Meaningful exit codes:** `0` success, `1` internal, `2` usage, `3` not
  found, `4` state conflict. Branch on these rather than on message text.
- **An empty result is success**, not an error — `tasks ready` with nothing
  available exits `0` with an empty array.

```sh
tasks ready --json | jq -r '.tasks[0].id' | xargs tasks claim
```

## Invariants the CLI enforces

- **No status skipping.** By default a task moves forward or back exactly one
  status, so nothing reaches "done" without having been worked. The last status
  is _not_ terminal — reopening is supported via `tasks claim`.
- **Claims are race-safe.** `claim` takes an exclusive `O_EXCL` lock and re-reads
  state inside it, so two concurrent agents cannot both take the same task. A
  lock from a crashed process goes stale after 10s and is reclaimed.
- **Dependencies fail safe.** Missing, archived, unresolvable, and cyclic
  dependencies all count as _blocking_ — never as satisfied. A typo can delay
  work, but it can never make an agent start something prematurely.
- **Ids are globally unique**, including archived ones, so a new task can never
  silently inherit a deleted task's inbound dependencies.
- **The filesystem is authoritative.** A task's phase comes from its directory
  and its identity from frontmatter `id`; `tasks validate --fix` repairs drift.
- **Writes are atomic** (temp file + rename) and frontmatter is rewritten in
  canonical form, so files never churn and diffs stay reviewable.

## Configuration

`.tasks/config.yml` is optional. Statuses are fully renameable, because commands
bind to _roles_ rather than literal status names:

```yaml
version: 1
active_phase: auth-rework # default scope for `list` and `ready`

statuses: [TODO, DOING, REVIEW, SHIPPED]

roles: # defaults: first / second / last of statuses
  ready: TODO # what `tasks ready` looks for
  claimed: DOING # what `tasks claim` moves to
  done: SHIPPED # what satisfies a dependency

transitions: # optional; REPLACES the default step rule
  - [TODO, DOING]
  - [DOING, REVIEW]
  - [REVIEW, SHIPPED]
  - [SHIPPED, DOING]
```

Config is validated on load: roles and transitions must name real statuses, and
a config where `ready → claimed` is illegal is rejected outright rather than
failing later at `tasks claim`.

## Dependencies across repos

`depends_on` entries are either a bare id or `<relative-path>:<id>`:

```yaml
depends_on: [token-schema, ../upstream-repo:publish-endpoint]
```

Cross-repo paths resolve relative to the project root (never the cwd, so
frontmatter resolves identically from any subdirectory), and absolute paths are
rejected because they don't survive a clone. The other repo is read-only, and a
dependency there is compared against _that_ project's `done` role.

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
