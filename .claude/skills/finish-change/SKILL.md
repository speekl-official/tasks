---
name: finish-change
description: Complete a user-facing change to @speekl/tasks — add the right changeset, sync every doc that mirrors CLI behavior, run the full gate, and reindex the task tree. Use after implementing any change to commands, flags, output, JSON shapes, exit codes, or .tasks/ conventions.
---

# Finish a change

Run this after the code works and tests pass. It closes out everything a user-facing change owes
beyond the implementation. Work through the steps in order and report what you did and what failed.

## 1. Decide whether a changeset is needed

Needed: new or removed commands and flags, changed output, JSON or exit-code changes, changed
`.tasks/` file conventions, bug fixes, dependency bumps that reach users.

Not needed: tests, refactors with no behavior change, CI config, internal docs, README edits.

If none is needed, say so and skip to step 3.

## 2. Write the changeset

Create `.changeset/<short-kebab-name>.md` directly rather than running the interactive
`pnpm changeset`:

```markdown
---
"@speekl/tasks": patch|minor|major
---

One or two sentences, past tense, describing what changed for the user.
```

Pick the bump by what breaks:

| Bump    | When                                                                                       |
| ------- | ------------------------------------------------------------------------------------------ |
| `patch` | Bug fixes and internal changes users can see but don't have to act on.                     |
| `minor` | New commands, flags, or output that existing usage keeps working with.                     |
| `major` | Anything that breaks an existing invocation, JSON shape, exit code, or on-disk convention. |

Agents branch on JSON shapes and exit codes — treat those as public API. Changing one is `major`.

## 3. Sync every doc that mirrors behavior

Check each and update the ones the change touches. Missing one is the usual failure here:

- `packages/tasks/README.md` — the command table and any flag description.
- `packages/tasks/skill/SKILL.md` — the command table plus the prose sections an agent reads
  ("When something looks wrong", etc.). This is the **source**; never edit `.claude/skills/tasks/`,
  which is an installed copy.
- `packages/tasks/skill/reference/convention.md` — only if the `.tasks/` layout changed.

## 4. Run the gate

From the repo root, in this order — it is exactly what CI runs:

```sh
pnpm lint && pnpm check-types && pnpm test && pnpm build
```

Report failures with their output rather than summarizing them.

## 5. Reindex the task tree

If the change was tracked in `.tasks/`, set the status (`tasks status <id> DONE`) and then run
`node packages/tasks/dist/index.js reindex` so the committed `_index.md` matches. Use the freshly
built local bin, not a globally installed `tasks`, so you exercise the code you just changed.

## 6. Hand off

Summarize: what changed, the changeset bump and why, which docs were updated, gate results. Leave
the changes uncommitted — Dan commits.
