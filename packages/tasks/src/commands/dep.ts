import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext } from "../context.js";
import type { Authorization } from "../core/archive.js";
import { addressTree, authorize, derivedTaskJson } from "../core/archive.js";
import { projectPathOf } from "../core/config.js";
import { splitTaskArgument } from "../core/ids.js";
import { withMutation } from "../core/mutate.js";
import type { LoadedTree } from "../core/projects.js";
import { resolveTaskArg, resolveTaskId, writeTask } from "../core/tree.js";
import type { GateField, ResolvedRef } from "../core/types.js";
import {
  appendLogEntry,
  forcedSuffix,
  logEntryFor,
  passedOverLine,
} from "../core/workspace.js";
import { TaskError, isTaskError } from "../errors.js";
import { emitJson, renderDepList, ui, writeOut } from "../output.js";

/** What distinguishes `dep` from `after`: the field and how to speak of it. */
interface GateSpec {
  /** The one line the command list shows. */
  summary: string;
  name: "dep" | "after";
  field: GateField;
  /** `<task> depends on <ref>`. */
  verb: string;
  /** `<task> does not depend on <ref>`. */
  negated: string;
  description: string;
}

const DEP: GateSpec = {
  name: "dep",
  summary: "edit and inspect depends_on, the start gate",
  field: "depends_on",
  verb: "depends on",
  negated: "does not depend on",
  description:
    "edit and inspect depends_on, the start gate: the tasks that must be\n" +
    "DONE before a task may be claimed or done",
};

const AFTER: GateSpec = {
  name: "after",
  summary:
    "edit and inspect finishes_after, the finish gate beyond the children",
  field: "finishes_after",
  verb: "finishes after",
  negated: "does not finish after",
  description:
    "edit and inspect finishes_after: tasks beyond its own children that\n" +
    "must be resolved before a task may be done; cancel does not wait for them",
};

interface EditOptions {
  force?: boolean;
  json?: boolean;
}

interface ListOptions {
  json?: boolean;
}

type EditAction = "add" | "rm";

/**
 * The stored form of a reference argument. It resolves like a task argument
 * — an alias prefix names a listed project, a bare path the local tree, and
 * the path is an exact id or an unambiguous suffix within that tree — and is
 * then written as `holder` must store it.
 */
async function storedForm(
  context: CommandContext,
  holder: LoadedTree,
  arg: string,
): Promise<string> {
  const { load, path } = await addressTree(context, arg, "reference");
  // The holder's own tree is read as of the lock the edit runs under.
  const target =
    load.key === holder.key ? holder : context.projects.latest(load);
  const id = resolveTaskId(target.tree, path);
  return context.projects.storedReference(holder, target, id);
}

/**
 * The stored form of an argument taken literally, as a full id in the tree
 * it names, for a reference whose target is gone and so cannot resolve.
 * `null` when no form can be told: a project neither loaded nor configured
 * by the holder.
 */
async function literalForm(
  context: CommandContext,
  holder: LoadedTree,
  arg: string,
  knownId: string | null,
): Promise<string | null> {
  const { prefix, path } = splitTaskArgument(arg);
  const id = knownId ?? path;
  if (prefix === null) {
    return context.projects.storedReference(holder, context.projects.local, id);
  }
  const target = await context.projects.byAlias(prefix);
  if (target.kind === "ok") {
    return context.projects.storedReference(
      holder,
      target.key === holder.key ? holder : target,
      id,
    );
  }
  // Not checked out here: the local tree stores the configured path.
  const configured = holder.local
    ? projectPathOf(holder.tree.config, prefix)
    : undefined;
  return configured === undefined ? null : `${configured}:${id}`;
}

/**
 * The entry of `stored` that `arg` names for removal: the argument exactly as
 * stored (how `list` prints it), else what it resolves to like `add`, else —
 * when its target no longer resolves — the argument taken as a full id.
 */
async function storedEntry(
  context: CommandContext,
  holder: LoadedTree,
  stored: readonly string[],
  arg: string,
): Promise<string | null> {
  if (stored.includes(arg)) return arg;

  let knownId: string | null = null;
  try {
    const form = await storedForm(context, holder, arg);
    if (stored.includes(form)) return form;
  } catch (err) {
    if (!isTaskError(err) || err.code !== "NOT_FOUND") throw err;
    // An archived target is named in full by the error.
    const details = err.details ?? {};
    if (details.archived === true && typeof details.id === "string") {
      knownId = details.id;
    }
  }

  const literal = await literalForm(context, holder, arg, knownId);
  return literal !== null && stored.includes(literal) ? literal : null;
}

function editLine(
  spec: GateSpec,
  action: EditAction,
  refs: readonly string[],
  authorization: Authorization,
): string {
  return `${spec.name} ${action}: ${refs.join(", ")}${forcedSuffix(authorization.forced)}`;
}

function supersededLine(authorization: Authorization): string | null {
  const claim = authorization.superseded;
  return claim === null
    ? null
    : passedOverLine(
        claim.claimant,
        claim.session,
        claim.liveness,
        claim.last_seen,
      );
}

interface EditOutcome {
  /** The task's id inside its tree. */
  id: string;
  shown: string;
  /** Stored forms added or removed. */
  changed: string[];
  /** Stored forms already present (`add` only); nothing was written for them. */
  unchanged: string[];
  /** The field after the edit. */
  refs: string[];
}

async function editGate(
  spec: GateSpec,
  action: EditAction,
  taskArg: string,
  refArgs: string[],
  options: EditOptions,
  command: Command,
): Promise<void> {
  const context = await openContext(command);
  const { load, path } = await addressTree(context, taskArg);

  const outcome = await withMutation(
    context,
    load,
    async (fresh): Promise<EditOutcome> => {
      const task = resolveTaskArg(fresh.tree, path);
      const shown = context.projects.qualify(fresh.load, task.id);
      const current = task.frontmatter[spec.field];
      const changed: string[] = [];
      const unchanged: string[] = [];

      if (action === "add") {
        for (const arg of refArgs) {
          const stored = await storedForm(context, fresh.load, arg);
          // Adding what is there is no change: the edit is idempotent.
          if (current.includes(stored) || changed.includes(stored)) {
            if (!unchanged.includes(stored)) unchanged.push(stored);
            continue;
          }
          changed.push(stored);
        }
        // Each new edge starts at this task, so a cycle closed by one of
        // them cannot run through another: checking each alone suffices.
        for (const stored of changed) {
          await context.gates.checkDependencyEdit(
            fresh.load,
            task,
            spec.field,
            stored,
          );
        }
      } else {
        for (const arg of refArgs) {
          const stored = await storedEntry(context, fresh.load, current, arg);
          if (stored === null) {
            throw TaskError.notFound(
              `${shown} ${spec.negated} ${arg}; it ${spec.verb} ${current.length === 0 ? "nothing" : current.join(", ")}.`,
              { id: shown, field: spec.field, ref: arg, refs: [...current] },
            );
          }
          if (!changed.includes(stored)) changed.push(stored);
        }
      }

      const refs =
        action === "add"
          ? [...current, ...changed]
          : current.filter((ref) => !changed.includes(ref));
      if (changed.length === 0) {
        return { id: task.id, shown, changed, unchanged, refs };
      }

      // Overridable last, so a forced retry cannot run into another refusal.
      const authorization = await authorize(
        fresh.tree,
        task,
        context.identity,
        { force: options.force, label: shown },
      );
      const frontmatter = { ...task.frontmatter, updated: fresh.now };
      frontmatter[spec.field] = refs;
      await writeTask({ ...task, frontmatter });
      await appendLogEntry(
        task.dir,
        logEntryFor(context.identity, fresh.now, [
          editLine(spec, action, changed, authorization),
          supersededLine(authorization),
        ]),
      );
      return { id: task.id, shown, changed, unchanged, refs };
    },
  );

  const json = await derivedTaskJson(context, load, outcome.id);
  if (context.json) {
    emitJson(json);
    return;
  }

  const lines: string[] = [];
  if (outcome.changed.length > 0) {
    lines.push(
      ui.success(
        `${spec.name} ${action} ${outcome.shown}: ${outcome.changed.join(", ")}`,
      ),
    );
  } else {
    lines.push(
      ui.info(
        `${outcome.shown} already ${spec.verb} ${outcome.unchanged.join(", ")}; nothing changed`,
      ),
    );
  }
  if (outcome.changed.length > 0 && outcome.unchanged.length > 0) {
    lines.push(`  already present: ${outcome.unchanged.join(", ")}`);
  }
  lines.push(
    `  ${ui.dim(`${spec.verb}: ${outcome.refs.length === 0 ? "nothing" : outcome.refs.join(", ")}`)}`,
  );
  writeOut(lines.join("\n"));
}

async function listGate(
  spec: GateSpec,
  taskArg: string,
  command: Command,
): Promise<void> {
  const context = await openContext(command);
  const { load, path } = await addressTree(context, taskArg);
  const task = resolveTaskArg(load.tree, path);
  // Each list is judged by its own gate: a CANCELLED task satisfies
  // finishes_after, never depends_on.
  const refs: ResolvedRef[] =
    spec.field === "depends_on"
      ? (await context.gates.startGate(load, task)).refs
      : (await context.gates.finishGate(load, task)).refs;
  const id = context.projects.qualify(load, task.id);

  if (context.json) {
    emitJson({ id, field: spec.field, refs });
    return;
  }
  writeOut(`${ui.bold(id)} ${ui.dim(spec.field)}`);
  writeOut(renderDepList(refs));
}

function gateCommand(spec: GateSpec): Command {
  // Before the subcommands: they inherit the override when created.
  const group = new Command(spec.name)
    .summary(spec.summary)
    .description(spec.description)
    .exitOverride()
    // An option on the bare group (`--json`) must not stop it short of its
    // own usage error, whose details the envelope then carries.
    .allowUnknownOption()
    // Without a subcommand there is nothing to do: an error, not help.
    .action(() => {
      throw TaskError.usage(
        `${spec.name} needs a subcommand: ${spec.name} add, ${spec.name} rm or ${spec.name} list.`,
        { command: spec.name, subcommands: ["add", "rm", "list"] },
      );
    });

  group
    .command("add")
    .description(
      "add references to the task; each <ref> resolves like <task> (alias:path,\n" +
        "a full id or an unambiguous suffix) and is stored in full",
    )
    .argument("<task>", "the task to edit")
    .argument("<refs...>", "the tasks to reference")
    .option(
      "--force",
      "override authorization (another session's live claim, an assignee); logged",
    )
    .option("--json", "emit machine-readable JSON")
    .action(
      (task: string, refs: string[], options: EditOptions, command: Command) =>
        editGate(spec, "add", task, refs, options, command),
    );

  group
    .command("rm")
    .description(
      "remove references from the task, named as stored or as for add",
    )
    .argument("<task>", "the task to edit")
    .argument("<refs...>", "the references to remove")
    .option(
      "--force",
      "override authorization (another session's live claim, an assignee); logged",
    )
    .option("--json", "emit machine-readable JSON")
    .action(
      (task: string, refs: string[], options: EditOptions, command: Command) =>
        editGate(spec, "rm", task, refs, options, command),
    );

  group
    .command("list")
    .description("show each reference and whether it is satisfied, and why not")
    .argument("<task>", "the task to inspect")
    .option("--json", "emit machine-readable JSON")
    .action((task: string, _options: ListOptions, command: Command) =>
      listGate(spec, task, command),
    );

  return group;
}

export function depCommand(): Command {
  return gateCommand(DEP);
}

export function afterCommand(): Command {
  return gateCommand(AFTER);
}
