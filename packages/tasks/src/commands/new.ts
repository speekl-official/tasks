import { Command } from "commander";

import { openContext } from "../context.js";
import { assertListedActor } from "../core/actors.js";
import {
  addressTree,
  checkPlacement,
  derivedTaskJson,
  displayPath,
} from "../core/archive.js";
import { compareIds } from "../core/ids.js";
import { withMutation } from "../core/mutate.js";
import { assertActor } from "../core/sessions.js";
import { isOpenTask, makeTask } from "../core/task.js";
import { taskBodyTemplate } from "../core/templates.js";
import type { Tree } from "../core/tree.js";
import {
  descendantsOf,
  malformedDescendantsOf,
  taskDir,
  writeTask,
} from "../core/tree.js";
import type { Frontmatter, Priority, Status } from "../core/types.js";
import { DEFAULT_PRIORITY, PRIORITIES, isPriority } from "../core/types.js";
import {
  appendLogEntry,
  creationLine,
  logEntryFor,
} from "../core/workspace.js";
import { TaskError } from "../errors.js";
import { emitJson, renderTransitionResult, ui, writeOut } from "../output.js";

interface NewOptions {
  backlog?: boolean;
  assign?: string;
  priority?: string;
  json?: boolean;
}

/** The title is the first heading of the body, so it is one line of text. */
function parseTitle(words: string[]): string {
  const title = words.join(" ").trim();
  if (title.length === 0) {
    throw TaskError.usage("A task needs a title.", { title });
  }
  if (/[\r\n]/.test(title)) {
    throw TaskError.usage(
      "A title is one line: it becomes the task's level-one heading.",
      { title },
    );
  }
  return title;
}

/**
 * A task created at a group's path adopts the tasks beneath it. Created in
 * BACKLOG, it would leave any of them that is open, and not BACKLOG itself,
 * scheduled inside an unscheduled subtree, which the containment invariant
 * forbids; an unreadable one may be such a task, so it refuses too. Created
 * in TODO, the task breaks nothing, and `defer` can then reach the subtree.
 */
function assertNothingScheduledBeneath(
  tree: Tree,
  id: string,
  qualify: (id: string) => string,
): void {
  const scheduled = [
    ...descendantsOf(tree, id)
      .filter(
        (task) => isOpenTask(task) && task.frontmatter.status !== "BACKLOG",
      )
      .map((task) => task.id),
    ...malformedDescendantsOf(tree, id).map((entry) => entry.id),
  ]
    .sort(compareIds)
    .map(qualify);
  if (scheduled.length === 0) return;
  throw TaskError.conflict(
    `${qualify(id)} cannot be created in BACKLOG over ${scheduled.join(", ")}: every open task beneath a BACKLOG task must be BACKLOG too. Create it in TODO and defer it, which reaches the whole subtree.`,
    {
      id: qualify(id),
      kind: "backlog-invariant",
      descendants: scheduled,
    },
  );
}

function parsePriority(value: string | undefined): Priority {
  if (value === undefined) return DEFAULT_PRIORITY;
  if (!isPriority(value)) {
    throw TaskError.usage(
      `Invalid --priority "${value}": expected one of ${PRIORITIES.join(", ")}.`,
      { priority: value, allowed: [...PRIORITIES] },
    );
  }
  return value;
}

export function newCommand(): Command {
  return new Command("new")
    .summary(
      "create a task at <path>; an existing group at the path becomes the task",
    )
    .description(
      "create a task at <path>, in TODO (BACKLOG under a BACKLOG parent);\n" +
        "groups are created on demand, and an existing group at the path\n" +
        "becomes the task, its tasks now the task's children",
    )
    .argument(
      "<path>",
      "the new task's id, e.g. auth-rework/token-schema; alias:path creates it in a listed project",
    )
    .argument("<title...>", "the title: the first heading of task.md")
    .option("--backlog", "create it in BACKLOG, not yet scheduled")
    .option("--assign <actor>", "set the assignee, who must act on it next")
    .option("--priority <level>", `set the priority: ${PRIORITIES.join(", ")}`)
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(
      async (
        arg: string,
        words: string[],
        options: NewOptions,
        command: Command,
      ) => {
        // Arguments first: a malformed invocation fails before any tree is read.
        const title = parseTitle(words);
        const assignee =
          options.assign === undefined
            ? null
            : assertActor(options.assign, "--assign");
        const priority = parsePriority(options.priority);

        const context = await openContext(command);
        // The destination is a new path, never resolved as a suffix.
        const { load, path: id } = await addressTree(context, arg, "path");

        const status = await withMutation(context, load, async (fresh) => {
          // The roster of the tree that will hold the task, as it is now.
          if (assignee !== null) {
            assertListedActor(
              fresh.tree.config,
              fresh.tree.project,
              assignee,
              "--assign",
            );
          }
          const placement = await checkPlacement(fresh.tree, id, {
            qualify: (value) => context.projects.qualify(fresh.load, value),
          });
          // A BACKLOG ancestor keeps its whole subtree unscheduled.
          const created: Status =
            placement.backlog !== null || options.backlog === true
              ? "BACKLOG"
              : "TODO";
          if (created === "BACKLOG") {
            assertNothingScheduledBeneath(fresh.tree, id, (value) =>
              context.projects.qualify(fresh.load, value),
            );
          }
          const frontmatter: Frontmatter = {
            status: created,
            priority,
            depends_on: [],
            finishes_after: [],
            assignee,
            claimed_by: null,
            claimed_at: null,
            claimed_session: null,
            created: fresh.now,
            updated: fresh.now,
          };
          const dir = taskDir(fresh.tree, id);
          await writeTask(
            makeTask({
              id,
              dir,
              archived: false,
              parent: placement.parent,
              frontmatter,
              body: taskBodyTemplate(title),
            }),
          );
          await appendLogEntry(
            dir,
            logEntryFor(context.identity, fresh.now, [creationLine(created)]),
          );
          return created;
        });

        const json = await derivedTaskJson(context, load, id);
        if (context.json) {
          emitJson(json);
          return;
        }
        writeOut(renderTransitionResult(json, { command: "new", to: status }));
        writeOut(`  ${ui.dim(`${status} · ${displayPath(json.path)}`)}`);
      },
    );
}
