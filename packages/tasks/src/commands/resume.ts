import { Command } from "commander";

import { deriveWithin, openContext, resolveTaskArgument } from "../context.js";
import type { DerivedTask } from "../core/derive.js";
import { docsLocations } from "../core/docs.js";
import { ancestorsOf, childrenOf } from "../core/tree.js";
import type {
  DocsLocationJson,
  TaskWithDerivedJson,
  WorkspaceFilename,
} from "../core/types.js";
import { readState, workspaceFiles } from "../core/workspace.js";
import type { ResumeAncestor } from "../output.js";
import { emitTaskJson, renderResume, writeOut } from "../output.js";
import { FIELDS_FLAG, FIELDS_HELP } from "./options.js";
import { TASK_ARGUMENT_HELP } from "./show.js";

/** What `resume --json` prints: the task object and its reading context. */
export interface ResumeJson extends TaskWithDerivedJson {
  /** Root first: `{ id, title, status, workspace }` per ancestor task. */
  ancestors: ResumeAncestor[];
  /** The children as task objects with derived conditions, in id order. */
  child_tasks: TaskWithDerivedJson[];
  workspace: WorkspaceFilename[];
  /** `state.md` in full, or `null` when there is none. */
  state: string | null;
  referenced_by: string[];
  /**
   * The documentation locations the holding tree's `config.yml` lists, in
   * configured order, each with whether it is present on this machine.
   */
  docs: DocsLocationJson[];
  body: string;
}

export function resumeCommand(): Command {
  return new Command("resume")
    .description(
      "everything the next session reads to continue a task: its definition, ancestors, children, workspace files, state.md in full, the last log entry and where the project's documentation lives",
    )
    .argument("<task>", TASK_ARGUMENT_HELP)
    .option("--json", "emit machine-readable JSON")
    .option(FIELDS_FLAG, FIELDS_HELP)
    .action(async (arg: string, _options: unknown, command: Command) => {
      const context = await openContext(command);
      const { load, task } = await resolveTaskArgument(context, arg);
      const { task: shown, derived } = await deriveWithin(
        context,
        load,
        task.id,
      );

      // Root first: the reading order goes from the outermost epic's design
      // down to the task. A malformed ancestor has no title or status to
      // show; `held_by` names it when it holds the task.
      const ancestors: ResumeAncestor[] = ancestorsOf(load.tree, task.id)
        .reverse()
        .map((ancestor) => ({
          id: context.projects.qualify(load, ancestor.id),
          title: ancestor.title,
          status: ancestor.frontmatter.status,
          workspace: workspaceFiles(ancestor),
        }));
      const children = childrenOf(load.tree, task.id).flatMap(
        (child): DerivedTask[] => {
          const entry = derived.get(child.id);
          return entry === undefined ? [] : [entry];
        },
      );
      const workspace = workspaceFiles(task);
      const state = await readState(task.dir);
      const referenced_by = await context.gates.referencedBy(load, task.id);
      const docs = await docsLocations(load.tree);

      if (context.json) {
        const result: ResumeJson = {
          ...shown.json,
          ancestors,
          // `children` is the {open, resolved} progress of the task object.
          child_tasks: children.map((child) => child.json),
          workspace,
          state,
          referenced_by,
          docs,
          body: task.body,
        };
        emitTaskJson(context, result);
        return;
      }
      writeOut(
        renderResume(shown, {
          body: task.body,
          ancestors,
          children,
          workspace,
          state,
          referenced_by,
          docs,
        }),
      );
    });
}
