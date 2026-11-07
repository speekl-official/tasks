import { yamlScalar } from "./frontmatter.js";
import { AGENT_ACTOR, AGENT_DESCRIPTION } from "./types.js";

/**
 * The scaffolds the CLI writes: a new tree's `config.yml`, `README.md` and
 * `.gitignore`, a new task's body, and the frame of `index.md`. Functions,
 * not constants, so a caller always gets a fresh string.
 */

export interface ConfigTemplateOptions {
  /**
   * The roster under `actors:`, in order: what `init` proposes (the resolved
   * actor, then `agent`). The generic example when absent.
   */
  actors?: Record<string, string | null>;
  /** Write the roster live, not as a commented example. */
  live?: boolean;
}

/** The roster `init` proposes: the resolved actor, then `agent`. */
export function defaultRoster(actor: string): Record<string, string | null> {
  const roster = Object.create(null) as Record<string, string | null>;
  roster[actor] = null;
  roster[AGENT_ACTOR] = AGENT_DESCRIPTION;
  return roster;
}

function exampleRoster(): Record<string, string | null> {
  const roster = Object.create(null) as Record<string, string | null>;
  roster.alice = "maintainer; approves plans and does releases";
  roster[AGENT_ACTOR] = AGENT_DESCRIPTION;
  return roster;
}

/**
 * Every key commented out, so the defaults apply until someone opts in; the
 * `actors:` block alone can be written live, which switches the roster on
 * from the first command. A name is quoted when YAML would read it as
 * something else (`007`, `true`); the descriptions are the CLI's own words,
 * safe as they are.
 */
export function configTemplate(options: ConfigTemplateOptions = {}): string {
  const prefix = options.live === true ? "" : "# ";
  const roster = Object.entries(options.actors ?? exampleRoster())
    .map(
      ([actor, description]) =>
        `${prefix}  ${yamlScalar(actor)}:${description === null ? "" : ` ${description}`}`,
    )
    .join("\n");
  return `# .tasks convention v2. See \`tasks --help\` or .tasks/README.md.
version: 2

# Default scope for \`list\`, \`ready\` and \`tree\`: a group or task path.
# scope: auth-rework

# Minutes without a heartbeat after which a claim counts as orphaned.
# session_timeout_minutes: 30

# Days after which a resolved task is expected to be archived: validate reports
# older ones, and tasks archive --resolved-before without a value uses it.
# archive_resolved_after_days: 30

# The actors tasks may be assigned to, each with a line on who they are. Once
# any is listed, assign, handoff, new --assign and --as refuse other names.
${prefix}actors:
${roster}

# Sibling trees by alias, as paths relative to this project's root.
# projects:
#   backend: ../backend
`;
}

/** Locks and session heartbeats are private to one working copy. */
export function gitignoreTemplate(): string {
  return `# Transient lock and session files; never committed.
.locks/
`;
}

/** Agent-facing description: where a cold agent learns the tool exists. */
export function readmeTemplate(): string {
  return `# Tasks

This directory is a git-versioned task tree in the \`.tasks\` convention v2,
managed by the \`tasks\` CLI. Every file is plain markdown and safe to read;
make changes through the CLI, which enforces the rules below.

## Layout

\`\`\`txt
.tasks/
  config.yml        version: 2, plus optional scope, session timeout, actors, projects
  README.md         this file
  .gitignore        keeps .locks/ out of version control
  index.md          optional generated overview; refresh with \`tasks reindex\`
  <group>/          a directory without task.md: organizational only
    <task>/         a directory with task.md is a task; its id is its path
      task.md       the definition: frontmatter and body
      state.md      where the work stands: the resume point
      design.md     decisions and why
      plan.md       steps, files, verification
      log.md        what happened; appended by the CLI
      <child>/      a child task: a part of the parent's deliverable
  .archive/         archived tasks, excluded from every query
  .locks/           transient lock and session files
\`\`\`

## For an agent starting work

\`\`\`sh
tasks mine                                # your claims and your inbox
tasks resume <task>                       # everything needed to continue one
tasks ready --json                        # what is free to take, best first
tasks claim --next --session <token>      # take the first ready task
tasks state <task> < state.md             # save the resume point
tasks pause <task> -m "where it stands"   # stop; the resume point stays
tasks done <task> -m "what was delivered" # finish
\`\`\`

Use one session token for every command of a session (\`--session\`, or
\`TASKS_SESSION\`), and name yourself with \`TASKS_ACTOR\`.

## Rules the CLI enforces

- **A fixed lifecycle.** \`BACKLOG\`, \`TODO\`, \`IN_PROGRESS\`, \`PAUSED\`, \`DONE\`,
  \`CANCELLED\`, changed only by transition commands; overviews show a computed
  situation instead (\`ready\`, \`blocked by X\`, \`waiting for X\`, …).
- **Gates.** A task is claimed only when every \`depends_on\` task is \`DONE\`, and
  done only when its children and \`finishes_after\` tasks are resolved; anything
  missing, archived or unreadable blocks.
- **Containment.** \`defer\`, \`schedule\` and \`cancel\` reach the whole subtree,
  and a claimed or assigned task holds everything beneath it.
- **A resume point.** \`pause\` and \`handoff\` need a \`state.md\`; \`release\` is
  for a claim that produced none.
- **Claims.** A claim is protected while its session is live; an orphaned one
  can be taken over. \`--force\` overrides authorization, holds and the start
  gate, never the finish gate, and the log records it.

Exit codes: 0 success, 1 internal, 2 usage, 3 not found, 4 conflict. Every
command accepts \`--json\`; errors then arrive as JSON on stderr. Branch on the
exit code, never on message text.

## Frontmatter

The YAML block at the top of \`task.md\` is machine-owned: the CLI rewrites it in
canonical form and does not keep comments there. The markdown body below it is
yours. \`tasks validate\` reports anything inconsistent.
`;
}

/**
 * Body scaffold for a new task: the definition (Description, Acceptance
 * criteria) apart from inputs received after the start (Notes).
 */
export function taskBodyTemplate(title: string): string {
  return `# ${title}

## Description

## Acceptance criteria

- [ ]

## Notes
`;
}

/** The frame of `index.md` around the rendered tree. */
export function indexTemplate(sections: string): string {
  return `<!-- Generated by \`tasks reindex\` from the task directories. Do not edit by hand. -->

# Task index

${sections.replace(/\n*$/, "\n")}`;
}
