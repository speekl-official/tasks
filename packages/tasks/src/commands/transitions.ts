import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext } from "../context.js";
import type { SupersededClaim } from "../core/authorization.js";
import type { TransitionResult } from "../core/transitions.js";
import {
  applyTransition,
  claimNext,
  transitionJson,
} from "../core/transitions.js";
import type { TransitionCommand } from "../core/types.js";
import { TaskError } from "../errors.js";
import { emitJson, renderTransitionResult, ui, writeOut } from "../output.js";

/**
 * The twelve transition commands of the spec's table. Each is a thin shell
 * over `core/transitions.ts`: parse, open the workspace, run the engine,
 * print the task object (with its derived conditions) or a one-line summary.
 */

interface TransitionFlags {
  message?: string;
  force?: boolean;
  json?: boolean;
}

interface ClaimFlags extends TransitionFlags {
  next?: boolean;
  scope?: string;
  all?: boolean;
  local?: boolean;
}

interface Spec {
  name: Exclude<TransitionCommand, "claim">;
  description: string;
  /** The second argument: the actor of handoff and assign, a level. */
  value?: { name: string; description: string };
  /** What `--force` lifts on this command, and what it never does. */
  force: string;
}

const TASK_HELP =
  "the task: its id, an unambiguous suffix of it, or alias:path in a listed project";

const AUTHORIZATION_FORCE =
  "override the authorization rules (logged as forced)";

const MESSAGE_REQUIRED: ReadonlySet<string> = new Set([
  "pause",
  "done",
  "cancel",
  "reopen",
  "handoff",
]);

const SPECS: readonly Spec[] = [
  {
    name: "schedule",
    description:
      "schedule a BACKLOG task: PAUSED when it has a state.md, else TODO; its BACKLOG descendants come with it",
    force: `${AUTHORIZATION_FORCE}; never a BACKLOG ancestor`,
  },
  {
    name: "defer",
    description:
      "defer a TODO or PAUSED task to BACKLOG with every open descendant; state.md and assignees are kept",
    force:
      "override the authorization rules and the refusal to reach a live or unknown claim (logged as forced)",
  },
  {
    name: "pause",
    description:
      "pause a task you are working on (IN_PROGRESS → PAUSED); needs its state.md and a message",
    force: `${AUTHORIZATION_FORCE}; never the state.md rule`,
  },
  {
    name: "release",
    description:
      "release a claim that produced nothing (IN_PROGRESS → TODO); refused while a state.md exists",
    force: `${AUTHORIZATION_FORCE}; never the state.md rule`,
  },
  {
    name: "done",
    description:
      "close a task as done; refused while a child or a finishes_after task is open",
    force:
      "override the authorization rules and the start gate (logged as forced); never the finish gate",
  },
  {
    name: "cancel",
    description:
      "cancel a task and every open descendant, and list the dependents it strands",
    force:
      "override the authorization rules and the refusal to reach a live or unknown claim (logged as forced)",
  },
  {
    name: "reopen",
    description:
      "reopen a DONE or CANCELLED task: BACKLOG under a BACKLOG ancestor, else PAUSED with a state.md, else TODO",
    force: `${AUTHORIZATION_FORCE}; never a resolved parent`,
  },
  {
    name: "handoff",
    description:
      "pause a task you are working on and assign it to <actor>, whose review or decision it now waits for",
    value: { name: "actor", description: "who acts on the task next" },
    force: `${AUTHORIZATION_FORCE}; never the state.md rule`,
  },
  {
    name: "assign",
    description:
      "set the actor a task waits on; an assigned task holds its subtree",
    value: { name: "actor", description: "who must act on the task next" },
    force: AUTHORIZATION_FORCE,
  },
  {
    name: "unassign",
    description: "clear a task's assignee, which releases its hold",
    force: AUTHORIZATION_FORCE,
  },
  {
    name: "priority",
    description:
      "set a task's priority: urgent, high, normal or low; descendants inherit the higher level",
    value: { name: "level", description: "urgent, high, normal or low" },
    force: AUTHORIZATION_FORCE,
  },
];

/** Every transition command, in the order of the spec's table. */
export function transitionCommands(): Command[] {
  const [scheduleSpec, deferSpec, ...rest] = SPECS;
  return [
    standardCommand(scheduleSpec!),
    standardCommand(deferSpec!),
    claimCommand(),
    ...rest.map(standardCommand),
  ];
}

function messageHelp(name: string): string {
  return MESSAGE_REQUIRED.has(name)
    ? "the note for the log, required: what happened and what comes next"
    : "a note for the log entry";
}

/**
 * The options every transition takes. A command added with `addCommand`
 * inherits none of the program's settings, so two are set here: parse
 * errors must reach `run()` as exceptions to leave with the usage exit code,
 * and the help lists `-C`, `--as` and `--session`, which every command takes.
 */
function withCommonOptions(command: Command, force: string): Command {
  return command
    .option("-m, --message <text>", messageHelp(command.name()))
    .option("--force", force)
    .option("--json", "emit machine-readable JSON")
    .configureHelp({ showGlobalOptions: true })
    .exitOverride();
}

function standardCommand(spec: Spec): Command {
  const command = new Command(spec.name)
    .description(spec.description)
    .argument("<task>", TASK_HELP);
  if (spec.value === undefined) {
    withCommonOptions(command, spec.force).action(
      async (task: string, flags: TransitionFlags, self: Command) => {
        await runTransition(self, spec.name, task, undefined, flags);
      },
    );
  } else {
    command.argument(`<${spec.value.name}>`, spec.value.description);
    withCommonOptions(command, spec.force).action(
      async (
        task: string,
        value: string,
        flags: TransitionFlags,
        self: Command,
      ) => {
        await runTransition(self, spec.name, task, value, flags);
      },
    );
  }
  return command;
}

async function runTransition(
  self: Command,
  name: TransitionCommand,
  task: string,
  value: string | undefined,
  flags: TransitionFlags,
): Promise<void> {
  const context = await openContext(self);
  const result = await applyTransition(context, {
    command: name,
    task,
    value,
    message: flags.message,
    force: flags.force,
  });
  report(context, result);
}

function claimCommand(): Command {
  const command = new Command("claim")
    .description(
      "claim a task to work on it now (BACKLOG, TODO or PAUSED → IN_PROGRESS) or take over an orphaned claim; --next takes the first ready task",
    )
    .argument("[task]", TASK_HELP)
    .option("--next", "claim the first task of your ready set, in ready order")
    .option(
      "--scope <path>",
      "with --next: only local tasks within this path (default: the configured scope)",
    )
    .option("--all", "with --next: ignore the configured scope")
    .option(
      "--local",
      "with --next: the local tree only, even when projects: lists others",
    );
  return withCommonOptions(
    command,
    "override the authorization rules, a live or unknown claim, the start gate and a hold (logged as forced); never a resolved parent or a BACKLOG ancestor",
  ).action(
    async (task: string | undefined, flags: ClaimFlags, self: Command) => {
      const narrowing =
        flags.scope !== undefined || flags.all === true || flags.local === true;
      if (flags.next === true) {
        if (task !== undefined) {
          throw TaskError.usage("claim takes a task or --next, not both.", {
            task,
          });
        }
        const context = await openContext(self);
        const result = await claimNext(context, {
          scope: flags.scope,
          all: flags.all,
          local: flags.local,
          message: flags.message,
          force: flags.force,
        });
        report(context, result);
        return;
      }
      if (narrowing) {
        throw TaskError.usage(
          "--scope, --all and --local choose among ready tasks: they go with --next.",
          {
            option:
              flags.scope !== undefined
                ? "--scope"
                : flags.all
                  ? "--all"
                  : "--local",
          },
        );
      }
      if (task === undefined) {
        throw TaskError.usage(
          "claim needs a task, or --next to take the first ready one.",
          {},
        );
      }
      await runTransition(self, "claim", task, undefined, flags);
    },
  );
}

/* ------------------------------------------------------------------------ */
/* Output                                                                   */
/* ------------------------------------------------------------------------ */

const FIELD_COMMANDS: ReadonlySet<string> = new Set([
  "assign",
  "unassign",
  "priority",
]);

function supersededText(claim: SupersededClaim): string {
  const session = claim.session === null ? "" : ` s:${claim.session}`;
  return `superseded ${claim.claimant}${session} on ${claim.id} (${claim.liveness}, last seen ${claim.last_seen ?? "unknown"})`;
}

function report(context: CommandContext, result: TransitionResult): void {
  if (context.json) {
    emitJson(transitionJson(result));
    return;
  }
  const field = FIELD_COMMANDS.has(result.command);
  const lines = [
    renderTransitionResult(result.task, {
      command: result.command,
      from: field ? undefined : result.from,
      to: field ? undefined : result.to,
      cascaded: result.cascaded ?? undefined,
      dependents: result.dependents ?? undefined,
      holds: result.holds ?? undefined,
    }),
  ];
  for (const claim of result.superseded) {
    lines.push(`  ${ui.dim(supersededText(claim))}`);
  }
  if (result.unchanged) {
    lines.push(`  ${ui.dim("already so: only the log entry was written")}`);
  }
  if (result.forced) {
    lines.push(`  ${ui.warn("forced: the log entry records it")}`);
  }
  writeOut(lines.join("\n"));
}
