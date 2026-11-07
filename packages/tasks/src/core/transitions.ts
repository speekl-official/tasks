import type { CommandContext } from "../context.js";
import { TaskError } from "../errors.js";
import { assertListedActor } from "./actors.js";
import type { SupersededClaim } from "./authorization.js";
import {
  authorizationDetailsOf,
  isClaimant,
  judgeAuthorization,
  supersededClaimOf,
} from "./authorization.js";
import type { DerivedTask } from "./derive.js";
import { holdsSubtree, readySet } from "./derive.js";
import { toBlockedBy, unavailableReason } from "./gates.js";
import { assertTaskPath, compareIds } from "./ids.js";
import type { Fresh } from "./mutate.js";
import { withMutation } from "./mutate.js";
import type { LoadedTree, UnavailableTree } from "./projects.js";
import { assertActor, claimLiveness } from "./sessions.js";
import { snapshotAll, snapshotFromContext, snapshotTree } from "./snapshot.js";
import type { Task } from "./task.js";
import type { Tree } from "./tree.js";
import {
  ancestorsOf,
  descendantsOf,
  isReservedPath,
  malformedAncestorOf,
  malformedDescendantsOf,
  resolveTaskId,
  writeTask,
} from "./tree.js";
import type {
  AncestorDetails,
  CascadeClaimDetails,
  ClaimLiveness,
  FinishGate,
  FinishGateDetails,
  Frontmatter,
  Identity,
  IllegalTransitionDetails,
  StartGate,
  StartGateDetails,
  StateDetails,
  Status,
  TaskWithDerivedJson,
  TransitionCommand,
} from "./types.js";
import {
  CASCADING_COMMANDS,
  OPEN_STATUSES,
  PRIORITIES,
  RESOLVED_STATUSES,
  TRANSITION_COMMANDS,
  isOpen,
  isPriority,
  isResolved,
} from "./types.js";
import type { LineOptions } from "./workspace.js";
import {
  appendLogEntry,
  assertLogText,
  cascadeLine,
  fieldLine,
  handoffLine,
  logEntryFor,
  reachedLine,
  takeoverLine,
  transitionLine,
  unassignLine,
} from "./workspace.js";

/**
 * The transition engine: the commands of the spec's transition table, the
 * authorization rules and `--force`, the containment cascades of `defer`,
 * `schedule` and `cancel`, takeovers of orphaned claims, and `claim --next`.
 *
 * Every command runs the same way. Arguments are checked before anything is
 * locked; then the target tree's lock is taken and the tree re-read, every
 * rule is decided from that fresh snapshot, and only once every refusal had
 * its chance is anything written — so a refused command leaves the tree as
 * it found it. A cascade writes the descendants first, deepest first, and
 * the named task last: interrupted, it is completed by repeating the
 * command, which skips what is already in place.
 */

/* ------------------------------------------------------------------------ */
/* Requests and results                                                     */
/* ------------------------------------------------------------------------ */

export interface TransitionOptions {
  /** `-m`; required by `pause`, `done`, `cancel`, `reopen` and `handoff`. */
  message?: string | null;
  /** `--force`: overrides exactly what the spec's Force section lists. */
  force?: boolean;
}

export interface TransitionRequest extends TransitionOptions {
  command: TransitionCommand;
  /** The task as typed: an id, an unambiguous suffix, or `alias:path`. */
  task: string;
  /** The actor of `handoff` and `assign`, the level of `priority`. */
  value?: string;
}

export interface ClaimNextOptions extends TransitionOptions {
  /** A path of the local tree; defaults to the configured `scope`. */
  scope?: string | null;
  /** Ignore the configured `scope` (an explicit `scope` still applies). */
  all?: boolean;
  /** Only the local tree, even when `projects:` lists others. */
  local?: boolean;
}

export interface TransitionResult {
  command: TransitionCommand;
  /** The task object after the command, with the derived conditions. */
  task: TaskWithDerivedJson;
  from: Status;
  /** Equal to `from` for `assign`, `unassign` and `priority`. */
  to: Status;
  /** True when `--force` overrode at least one refusal. */
  forced: boolean;
  /**
   * The tasks the cascade reached, qualified when foreign, in tree order;
   * an array for `defer`, `schedule` and `cancel`, `null` otherwise.
   */
  cascaded: string[] | null;
  /** `cancel` only: the live tasks whose `depends_on` it stranded. */
  dependents: string[] | null;
  /** `claim`, `assign` and `handoff`: the open descendants now held. */
  holds: number | null;
  /** Claims passed over: the named task's and those of reached tasks. */
  superseded: SupersededClaim[];
  /** `assign` or `priority` to the value already set: only logged. */
  unchanged: boolean;
}

/**
 * The JSON a transition prints: the task object with its derived
 * conditions, plus `cascaded` for the cascading commands, `dependents` for
 * `cancel`, and `holds` when the task now holds open descendants.
 */
export type TransitionJson = TaskWithDerivedJson & {
  cascaded?: string[];
  dependents?: string[];
  holds?: number;
};

export function transitionJson(result: TransitionResult): TransitionJson {
  return {
    ...result.task,
    ...(result.cascaded === null ? {} : { cascaded: result.cascaded }),
    ...(result.dependents === null ? {} : { dependents: result.dependents }),
    ...(result.holds === null ? {} : { holds: result.holds }),
  };
}

/* ------------------------------------------------------------------------ */
/* The table                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The From column of the transition table. A status transition into its own
 * status is never legal, and none of these rows allows one; a takeover
 * `claim` on an `IN_PROGRESS` task is the single exception and is handled
 * apart, because it moves the claim, not the status.
 */
const FROM: Record<TransitionCommand, readonly Status[]> = {
  schedule: ["BACKLOG"],
  defer: ["TODO", "PAUSED"],
  claim: ["BACKLOG", "TODO", "PAUSED"],
  pause: ["IN_PROGRESS"],
  release: ["IN_PROGRESS"],
  done: OPEN_STATUSES,
  cancel: OPEN_STATUSES,
  reopen: RESOLVED_STATUSES,
  handoff: ["IN_PROGRESS"],
  assign: OPEN_STATUSES,
  unassign: OPEN_STATUSES,
  priority: OPEN_STATUSES,
};

/** A message is the closing note: required where work stops or changes fate. */
const MESSAGE_REQUIRED: ReadonlySet<TransitionCommand> = new Set([
  "pause",
  "done",
  "cancel",
  "reopen",
  "handoff",
]);

/** They change one field each and leave the status as it is. */
const FIELD_COMMANDS: ReadonlySet<TransitionCommand> = new Set([
  "assign",
  "unassign",
  "priority",
]);

/** Commands after which the task may hold its subtree (see Hold). */
const HOLDING_COMMANDS: ReadonlySet<TransitionCommand> = new Set([
  "claim",
  "assign",
  "handoff",
]);

/**
 * How many times `claim --next` re-reads the ready set after every candidate
 * of a round was taken by someone faster. A crowd of agents reading one list
 * mostly settles in the first round; the rest catch tasks that became ready
 * while the round ran.
 */
const NEXT_ROUNDS = 3;

/**
 * The claim fields of an unclaimed task. Exported for `move`, whose defer
 * under a `BACKLOG` parent clears claims as the cascade does.
 */
export const NO_CLAIM = {
  claimed_by: null,
  claimed_at: null,
  claimed_session: null,
} as const;

/* ------------------------------------------------------------------------ */
/* Entry points                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Run one transition command against the task `request.task` names: in the
 * local tree, or in a listed project addressed as `alias:path`, under that
 * tree's own lock.
 */
export async function applyTransition(
  context: CommandContext,
  request: TransitionRequest,
): Promise<TransitionResult> {
  const prepared = prepare(request.command, request, request.value);
  const { load, id } = await locate(context, request.task);
  const outcome = await withMutation(context, load, (fresh) =>
    decide(new Run(context, fresh, prepared), id),
  );
  return finish(context, load, outcome);
}

/** `schedule`: `BACKLOG` → `PAUSED` with a `state.md`, else `TODO`. */
export function schedule(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "schedule", task });
}

/** `defer`: `TODO` or `PAUSED` → `BACKLOG`, with every open descendant. */
export function defer(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "defer", task });
}

/** `claim <task>`: take the task, or take over an orphaned claim on it. */
export function claim(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "claim", task });
}

/** `pause`: `IN_PROGRESS` → `PAUSED`; needs a `state.md` and a message. */
export function pause(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "pause", task });
}

/** `release`: `IN_PROGRESS` → `TODO`, for a claim that produced nothing. */
export function release(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "release", task });
}

/** `done`: any open status → `DONE`, through both gates. */
export function done(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "done", task });
}

/** `cancel`: any open status → `CANCELLED`, with every open descendant. */
export function cancel(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "cancel", task });
}

/** `reopen`: `DONE` or `CANCELLED` back to an open status. */
export function reopen(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "reopen", task });
}

/** `handoff <actor>`: `pause`, then `assign <actor>`, in one log entry. */
export function handoff(
  context: CommandContext,
  task: string,
  actor: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, {
    ...options,
    command: "handoff",
    task,
    value: actor,
  });
}

/** `assign <actor>`: set who the task waits on; no status change. */
export function assign(
  context: CommandContext,
  task: string,
  actor: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, {
    ...options,
    command: "assign",
    task,
    value: actor,
  });
}

/** `unassign`: clear the assignee, which releases its hold. */
export function unassign(
  context: CommandContext,
  task: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, { ...options, command: "unassign", task });
}

/** `priority <level>`: one of `urgent`, `high`, `normal`, `low`. */
export function priority(
  context: CommandContext,
  task: string,
  level: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return applyTransition(context, {
    ...options,
    command: "priority",
    task,
    value: level,
  });
}

/**
 * `claim --next`: claim the first task of the caller's ready set. The set
 * spans the local tree and every listed tree that is available (only the
 * local one with `local`); a scope narrows the local tree only.
 *
 * There is no lock over several trees, so the candidates come from an
 * unlocked read in ready order, and each is re-checked under its own tree's
 * lock before it is claimed: a candidate another agent took meanwhile is no
 * longer ready there, and the next one is tried. That is what hands every
 * agent of a crowd a different task. Nothing to take is *not found*.
 */
export async function claimNext(
  context: CommandContext,
  options: ClaimNextOptions = {},
): Promise<TransitionResult> {
  const prepared = prepare("claim", options, undefined);
  const scope = nextScope(context, options);
  const source = snapshotFromContext(context);
  const actor = context.identity.actor;
  const local = options.local === true;

  for (let round = 0; round < NEXT_ROUNDS; round += 1) {
    if (round > 0) await reloadAll(context, local);
    const owners = new Map<DerivedTask, LoadedTree>();
    for (const view of await snapshotAll(source, actor, { local })) {
      for (const derived of view.derived.values()) {
        owners.set(derived, view.load);
      }
    }
    const candidates = readySet(owners.keys(), {
      scope,
      aliasOrder: context.projects.aliases(),
    });
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      const load = owners.get(candidate)!;
      const id = candidate.snapshot.task.id;
      const outcome = await withMutation(context, load, async (fresh) => {
        const { derived } = await snapshotTree(source, fresh.load, actor);
        if (derived.get(id)?.derived.ready !== true) return null;
        return decide(new Run(context, fresh, prepared), id);
      });
      if (outcome !== null) return finish(context, load, outcome);
    }
  }

  const where = scope === null ? "" : ` within ${scope}`;
  throw TaskError.notFound(`Nothing is ready for ${actor} to claim${where}.`, {
    scope,
  });
}

/* ------------------------------------------------------------------------ */
/* Before the lock                                                          */
/* ------------------------------------------------------------------------ */

interface Prepared {
  command: TransitionCommand;
  /** `null` when none was given (an empty one counts as none). */
  message: string | null;
  force: boolean;
  /** The checked actor of `handoff` and `assign`, level of `priority`. */
  value: string | null;
}

/** Everything that can be refused without reading the tree. */
function prepare(
  command: TransitionCommand,
  options: TransitionOptions,
  value: string | undefined,
): Prepared {
  if (!(TRANSITION_COMMANDS as readonly string[]).includes(command)) {
    throw TaskError.internal(`Unknown transition command "${command}".`, {
      command,
    });
  }
  const message =
    typeof options.message === "string" && options.message.trim() !== ""
      ? options.message
      : null;
  if (message === null && MESSAGE_REQUIRED.has(command)) {
    throw TaskError.usage(
      `${command} needs a message: pass -m <text>. It is the note the next reader of the task finds in its log.`,
      { command, option: "--message" },
    );
  }
  // Refused here, before the lock: a message that would corrupt the log
  // must not leave half a cascade behind.
  if (message !== null) assertLogText(message);
  return {
    command,
    message,
    force: options.force === true,
    value: checkValue(command, value),
  };
}

function checkValue(
  command: TransitionCommand,
  value: string | undefined,
): string | null {
  switch (command) {
    case "handoff":
    case "assign":
      return assertActor(value ?? "", "actor");
    case "priority":
      if (!isPriority(value)) {
        throw TaskError.usage(
          `Invalid priority ${JSON.stringify(value ?? "")}: expected one of ${PRIORITIES.join(", ")}.`,
          { priority: value ?? null, allowed: [...PRIORITIES] },
        );
      }
      return value;
    default:
      return null;
  }
}

/**
 * The tree and id a command-line argument names. The suffix is resolved
 * against the latest snapshot; the lock then re-reads the task by that id.
 */
async function locate(
  context: CommandContext,
  argument: string,
): Promise<{ load: LoadedTree; id: string }> {
  const { target, path } = await context.projects.resolveArgument(argument);
  if (target.kind !== "ok") throw unavailable(argument, target);
  if (!target.writable) {
    // Unreachable through an alias, which always names a listed tree; kept
    // so that no path into a read-only tree can ever reach a write.
    throw TaskError.usage(
      `${argument} lies in a tree this one does not list under projects:, which is read-only from here.`,
      { argument },
    );
  }
  const load = context.projects.latest(target);
  return { load, id: resolveTaskId(load.tree, path) };
}

function unavailable(argument: string, target: UnavailableTree): TaskError {
  const name = target.alias ?? target.relPath;
  let why: string;
  switch (target.kind) {
    case "not-checked-out":
      why = `is not checked out at ${target.dir}`;
      break;
    case "unsupported-version":
      why =
        target.version === 1
          ? `is a .tasks v1 tree; run \`tasks migrate ${name}\` to upgrade it`
          : `is a .tasks v${target.version} tree, which this tasks does not support`;
      break;
    case "unresolved":
      why = `does not resolve to a readable .tasks tree at ${target.dir}${target.cause === null ? "" : ` (${target.cause.message})`}`;
      break;
  }
  return TaskError.notFound(
    `Cannot address ${argument}: project ${name} ${why}.`,
    {
      argument,
      project: name,
      reason: unavailableReason(target),
    },
  );
}

function nextScope(
  context: CommandContext,
  options: ClaimNextOptions,
): string | null {
  if (typeof options.scope === "string") {
    return assertTaskPath(options.scope, "scope");
  }
  return options.all === true ? null : context.tree.config.scope;
}

/** Re-read every tree a `claim --next` round spans. */
async function reloadAll(
  context: CommandContext,
  local: boolean,
): Promise<void> {
  const loads = local
    ? [context.projects.local]
    : await context.projects.writableTrees();
  for (const load of loads) await context.projects.reload(load);
  context.gates.invalidate();
}

/* ------------------------------------------------------------------------ */
/* Inside the lock                                                          */
/* ------------------------------------------------------------------------ */

/** One command deciding inside one tree's lock. */
class Run {
  readonly context: CommandContext;
  readonly fresh: Fresh;
  readonly prepared: Prepared;
  /** Set as soon as `--force` lifts a refusal; every entry then says so. */
  forced = false;

  constructor(context: CommandContext, fresh: Fresh, prepared: Prepared) {
    this.context = context;
    this.fresh = fresh;
    this.prepared = prepared;
  }

  get tree(): Tree {
    return this.fresh.tree;
  }

  get identity(): Identity {
    return this.context.identity;
  }

  get command(): TransitionCommand {
    return this.prepared.command;
  }

  /** How output and error details name a task of this tree. */
  shown(id: string): string {
    return this.context.projects.qualify(this.fresh.load, id);
  }

  /** A refusal `--force` may lift: thrown without it, recorded with it. */
  overridable(refusal: () => TaskError): void {
    if (!this.prepared.force) throw refusal();
    this.forced = true;
  }
}

/** A descendant a cascade writes. */
interface Reach {
  task: Task;
  from: Status;
  to: Status;
  superseded: SupersededClaim | null;
}

/** What a run decided and wrote, for the result. */
interface Outcome {
  id: string;
  command: TransitionCommand;
  from: Status;
  to: Status;
  forced: boolean;
  /** Ids the cascade wrote, unqualified, in tree order. */
  reached: string[];
  superseded: SupersededClaim[];
  unchanged: boolean;
}

/**
 * Decide everything from the fresh tree, then write. The order of the checks
 * follows the precondition column of the spec's table, so the first refusal
 * a caller sees is the one the table names first.
 */
async function decide(run: Run, id: string): Promise<Outcome> {
  checkListedValue(run);
  const task = lookup(run, id);
  const from = task.frontmatter.status;
  const claimed =
    from === "IN_PROGRESS" ? await claimLiveness(run.tree, task) : null;

  const takeover = run.command === "claim" && claimed !== null;
  const to = targetOf(run, task);
  if (!takeover && !FROM[run.command].includes(from)) {
    throw illegalTransition(run, task, to);
  }
  if (takeover && isSameSession(task.frontmatter, run.identity)) {
    throw alreadyClaimed(run, task, claimed);
  }

  const superseded = authorize(run, task, claimed);
  await preconditions(run, task, takeover);
  const reached = (CASCADING_COMMANDS as readonly string[]).includes(
    run.command,
  )
    ? await planCascade(run, task)
    : [];

  const unchanged = await write(run, task, from, to, superseded, reached);
  const ids = reached.map((reach) => reach.task.id).sort(compareIds);
  return {
    id: task.id,
    command: run.command,
    from,
    to,
    forced: run.forced,
    reached: ids,
    superseded: [
      ...(superseded === null ? [] : [superseded]),
      ...reached.flatMap((reach) =>
        reach.superseded === null ? [] : [reach.superseded],
      ),
    ],
    unchanged,
  };
}

/**
 * The actor `assign` and `handoff` name must be on this tree's roster when
 * it has one; judged inside the lock, by the configuration as it is now.
 */
function checkListedValue(run: Run): void {
  const { value } = run.prepared;
  if (value === null) return;
  if (run.command !== "assign" && run.command !== "handoff") return;
  assertListedActor(run.tree.config, run.tree.project, value, "actor");
}

/** The task by its exact id in the fresh tree: it may have changed. */
function lookup(run: Run, id: string): Task {
  const task = run.tree.byId.get(id);
  if (task !== undefined) return task;
  const shown = run.shown(id);
  const broken = run.tree.malformedById.get(id);
  if (broken !== undefined) {
    throw TaskError.conflict(
      `${shown} has a malformed task.md: ${broken.message}. Fix ${broken.path} by hand first.`,
      {
        id: shown,
        kind: "malformed",
        path: broken.path,
        message: broken.message,
      },
    );
  }
  if (isReservedPath(run.tree, id)) {
    throw TaskError.notFound(`${shown} was archived meanwhile.`, {
      id: shown,
      archived: true,
    });
  }
  throw TaskError.notFound(
    `No task "${shown}": it was moved or removed meanwhile.`,
    {
      id: shown,
    },
  );
}

/** The status the command writes; the current one for the field commands. */
function targetOf(run: Run, task: Task): Status {
  const own = task.frontmatter.status;
  const resume: Status = task.workspace.state ? "PAUSED" : "TODO";
  switch (run.command) {
    case "schedule":
      return resume;
    case "defer":
      return "BACKLOG";
    case "claim":
      return "IN_PROGRESS";
    case "pause":
    case "handoff":
      return "PAUSED";
    case "release":
      return "TODO";
    case "done":
      return "DONE";
    case "cancel":
      return "CANCELLED";
    case "reopen":
      // The BACKLOG invariant: nothing reopens past an unscheduled ancestor.
      return ancestorsOf(run.tree, task.id).some(
        (ancestor) => ancestor.frontmatter.status === "BACKLOG",
      )
        ? "BACKLOG"
        : resume;
    case "assign":
    case "unassign":
    case "priority":
      return own;
  }
}

/* ------------------------------------------------------------------------ */
/* Authorization                                                            */
/* ------------------------------------------------------------------------ */

/** The claim's own actor from its own session: the task is already theirs. */
function isSameSession(fm: Frontmatter, identity: Identity): boolean {
  return (
    fm.claimed_by === identity.actor && fm.claimed_session === identity.session
  );
}

/**
 * The authorization rules on the task the command names; a cascade's
 * descendants are never checked here (their live work is the cascade
 * liveness rule's). Returns the claim the command passes over: an orphaned
 * one, which protects nothing, or a live or unknown one `--force` overrode.
 */
function authorize(
  run: Run,
  task: Task,
  claimed: ClaimLiveness | null,
): SupersededClaim | null {
  const verdict = judgeAuthorization({
    task,
    ancestors: ancestorsOf(run.tree, task.id),
    identity: run.identity,
    claimed,
    shown: run.shown(task.id),
    command: run.command,
  });
  if (!verdict.admitted) {
    const { refusal } = verdict;
    run.overridable(() => refusal);
  }
  return verdict.superseded;
}

/* ------------------------------------------------------------------------ */
/* Preconditions                                                            */
/* ------------------------------------------------------------------------ */

async function preconditions(
  run: Run,
  task: Task,
  takeover: boolean,
): Promise<void> {
  switch (run.command) {
    case "schedule":
      refuseUnderBacklog(run, task);
      return;
    case "claim":
      // A takeover moves a claim that already passed these when the work
      // started; it must succeed whenever the claim is orphaned and the
      // actor authorized, whatever happened around the task since.
      if (!takeover) await claimPreconditions(run, task);
      return;
    case "pause":
    case "handoff":
      if (!task.workspace.state) throw stateRefusal(run, task, "missing-state");
      return;
    case "release":
      if (task.workspace.state) throw stateRefusal(run, task, "present-state");
      return;
    case "done":
      await donePreconditions(run, task);
      return;
    case "reopen":
      refuseUnderResolved(run, task);
      return;
    case "unassign":
      if (task.frontmatter.assignee === null) throw notAssigned(run, task);
      return;
    default:
      return;
  }
}

/** Start gate, open parent, no `BACKLOG` ancestor, no hold. */
async function claimPreconditions(run: Run, task: Task): Promise<void> {
  await checkStartGate(run, task);
  refuseUnderResolved(run, task);
  const ancestors = ancestorsOf(run.tree, task.id);
  refuseUnderBacklogAncestor(run, task, ancestors);
  const holder = ancestors.find(holdsSubtree);
  if (holder !== undefined) {
    run.overridable(() => holdRefusal(run, task, holder));
  }
}

async function donePreconditions(run: Run, task: Task): Promise<void> {
  await checkStartGate(run, task);
  const finish = await run.context.gates.finishGate(run.fresh.load, task);
  if (!finish.satisfied) throw finishGateRefusal(run, task, finish);
}

async function checkStartGate(run: Run, task: Task): Promise<void> {
  const start = await run.context.gates.startGate(run.fresh.load, task);
  if (!start.satisfied) {
    run.overridable(() => startGateRefusal(run, task, start));
  }
}

/**
 * Rules that read the ancestors cannot be confirmed through a manifest that
 * does not parse: fail safe, and name it.
 */
function refuseUnderMalformed(run: Run, task: Task): void {
  const broken = malformedAncestorOf(run.tree, task.id);
  if (broken === null) return;
  const shown = run.shown(task.id);
  const ancestor = run.shown(broken.id);
  throw TaskError.conflict(
    `${run.command} ${shown} depends on its ancestor ${ancestor}, whose task.md is malformed: ${broken.message}. Fix ${broken.path} by hand first.`,
    {
      ...ancestorDetails(run, task, broken.id),
      kind: "malformed-ancestor",
      path: broken.path,
    },
  );
}

/** `schedule` under a `BACKLOG` ancestor: the remedy is one command. */
function refuseUnderBacklog(run: Run, task: Task): void {
  refuseUnderMalformed(run, task);
  refuseUnderBacklogAncestor(run, task, ancestorsOf(run.tree, task.id));
}

/**
 * Names the topmost `BACKLOG` ancestor: scheduling it is the one command
 * that succeeds, and its cascade reaches this task too. Nothing overrides
 * this; the `BACKLOG` subtree is an invariant.
 */
function refuseUnderBacklogAncestor(
  run: Run,
  task: Task,
  ancestors: Task[],
): void {
  const backlog = [...ancestors]
    .reverse()
    .find((ancestor) => ancestor.frontmatter.status === "BACKLOG");
  if (backlog === undefined) return;
  const shown = run.shown(task.id);
  const ancestor = run.shown(backlog.id);
  const what = run.command === "schedule" ? "be scheduled" : "be claimed";
  throw TaskError.conflict(
    `${shown} cannot ${what} under ${ancestor}, which is BACKLOG. Run \`tasks schedule ${ancestor}\` first; it schedules the subtree with it.`,
    { ...ancestorDetails(run, task, backlog.id), kind: "backlog-ancestor" },
  );
}

/** A resolved parent is protected: nothing beneath it reopens or starts. */
function refuseUnderResolved(run: Run, task: Task): void {
  refuseUnderMalformed(run, task);
  // The nearest resolved ancestor; in a valid tree only the parent can be.
  const resolved = ancestorsOf(run.tree, task.id).find((ancestor) =>
    isResolved(ancestor.frontmatter.status),
  );
  if (resolved === undefined) return;
  const shown = run.shown(task.id);
  const ancestor = run.shown(resolved.id);
  const status = resolved.frontmatter.status;
  const what = run.command === "reopen" ? "be reopened" : "be claimed";
  throw TaskError.conflict(
    `${shown} cannot ${what} while ${ancestor} is ${status}. Reopen ${ancestor} first.`,
    {
      ...ancestorDetails(run, task, resolved.id),
      kind: "resolved-ancestor",
      status,
    },
  );
}

/* ------------------------------------------------------------------------ */
/* Cascades                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The status a cascade gives a descendant, or `null` when it is not reached.
 * Exported for `move`, which defers a subtree it places under a `BACKLOG`
 * parent exactly as `defer` would.
 */
export function cascadeTarget(
  command: TransitionCommand,
  task: Task,
): Status | null {
  const status = task.frontmatter.status;
  switch (command) {
    case "defer":
      return isOpen(status) && status !== "BACKLOG" ? "BACKLOG" : null;
    case "schedule":
      if (status !== "BACKLOG") return null;
      return task.workspace.state ? "PAUSED" : "TODO";
    case "cancel":
      return isOpen(status) ? "CANCELLED" : null;
    default:
      return null;
  }
}

/**
 * The descendants a cascade writes, deepest first. A descendant already in
 * its target status is not reached, which is what makes a repeat complete
 * an interrupted cascade. The cascade liveness rule applies the claimant
 * rule to the whole command: a live or unknown claim that is not the
 * actor's own refuses it, an orphaned one is superseded.
 */
async function planCascade(run: Run, task: Task): Promise<Reach[]> {
  const shown = run.shown(task.id);
  const broken = malformedDescendantsOf(run.tree, task.id);
  if (broken.length > 0) {
    // Whatever such a manifest says, the cascade cannot write it; force does
    // not make it parse.
    const descendants = broken.map((entry) => run.shown(entry.id));
    throw TaskError.conflict(
      `${run.command} ${shown} cannot reach ${descendants.join(", ")}: the task.md cannot be parsed. Fix it by hand first.`,
      { id: shown, kind: "malformed-descendants", descendants },
    );
  }

  const reach: Reach[] = [];
  const live: CascadeClaimDetails["claims"] = [];
  for (const descendant of descendantsOf(run.tree, task.id, {
    deepestFirst: true,
  })) {
    const to = cascadeTarget(run.command, descendant);
    if (to === null) continue;
    const from = descendant.frontmatter.status;
    let superseded: SupersededClaim | null = null;
    if (
      from === "IN_PROGRESS" &&
      !isClaimant(descendant.frontmatter, run.identity)
    ) {
      const claimed = await claimLiveness(run.tree, descendant);
      superseded = supersededClaimOf(
        run.shown(descendant.id),
        descendant.frontmatter,
        claimed,
      );
      if (claimed.liveness !== "orphaned") {
        live.push({
          id: run.shown(descendant.id),
          claimant: descendant.frontmatter.claimed_by ?? "",
          session: descendant.frontmatter.claimed_session,
          liveness: claimed.liveness,
        });
      }
    }
    reach.push({ task: descendant, from, to, superseded });
  }

  if (live.length > 0) {
    run.overridable(() => cascadeClaimRefusal(run, task, live));
  }
  return reach;
}

/* ------------------------------------------------------------------------ */
/* Writing                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Descendants first, deepest first, each manifest then its log entry; the
 * named task last. Returns whether the named task's manifest was left
 * untouched because the command changed nothing in it.
 */
async function write(
  run: Run,
  task: Task,
  from: Status,
  to: Status,
  superseded: SupersededClaim | null,
  reached: Reach[],
): Promise<boolean> {
  const { now } = run.fresh;
  const message = run.prepared.message;
  const options: LineOptions = { forced: run.forced };

  for (const reach of reached) {
    await writeTask({
      ...reach.task,
      frontmatter: {
        ...reach.task.frontmatter,
        status: reach.to,
        ...NO_CLAIM,
        updated: now,
      },
    });
    // Ids in a log are the tree's own: an alias means nothing inside it.
    await appendLogEntry(
      reach.task.dir,
      logEntryFor(run.identity, now, [
        cascadeLine(run.command, task.id, reach.from, reach.to, options),
        supersededLine(reach.superseded),
        message,
      ]),
    );
  }

  const next = nextFrontmatter(run, task, to);
  if (next !== null) await writeTask({ ...task, frontmatter: next });
  const ids = reached.map((reach) => reach.task.id).sort(compareIds);
  await appendLogEntry(
    task.dir,
    logEntryFor(run.identity, now, [
      firstLine(run, from, to, options),
      supersededLine(superseded),
      ids.length > 0 ? reachedLine(ids) : null,
      message,
    ]),
  );
  return next === null;
}

/**
 * The manifest after the command, or `null` when it would not change: an
 * `assign` of the current assignee or a `priority` of the current level is
 * a reiteration that the log records and the manifest does not.
 */
function nextFrontmatter(run: Run, task: Task, to: Status): Frontmatter | null {
  const fm = task.frontmatter;
  const { now } = run.fresh;
  const value = run.prepared.value;
  switch (run.command) {
    case "assign":
      return fm.assignee === value
        ? null
        : { ...fm, assignee: value, updated: now };
    case "unassign":
      return { ...fm, assignee: null, updated: now };
    case "priority":
      return fm.priority === value || !isPriority(value)
        ? null
        : { ...fm, priority: value, updated: now };
    case "claim":
      return {
        ...fm,
        status: "IN_PROGRESS",
        claimed_by: run.identity.actor,
        claimed_at: now,
        claimed_session: run.identity.session,
        updated: now,
      };
    case "handoff":
      return { ...fm, status: to, ...NO_CLAIM, assignee: value, updated: now };
    default:
      // Every other status is unclaimed: the claim fields go with the claim.
      return { ...fm, status: to, ...NO_CLAIM, updated: now };
  }
}

function firstLine(
  run: Run,
  from: Status,
  to: Status,
  options: LineOptions,
): string {
  const value = run.prepared.value ?? "";
  switch (run.command) {
    case "handoff":
      return handoffLine(value, options);
    case "assign":
      return fieldLine("assign", value, options);
    case "unassign":
      return unassignLine(options);
    case "priority":
      return fieldLine("priority", value, options);
    default:
      return transitionLine(run.command, from, to, options);
  }
}

function supersededLine(claim: SupersededClaim | null): string | null {
  return claim === null
    ? null
    : takeoverLine(claim.claimant, claim.session, claim.last_seen);
}

/* ------------------------------------------------------------------------ */
/* After the lock                                                           */
/* ------------------------------------------------------------------------ */

/** The result as the tree reads now, derived for the calling actor. */
async function finish(
  context: CommandContext,
  load: LoadedTree,
  outcome: Outcome,
): Promise<TransitionResult> {
  const latest = context.projects.latest(load);
  const { derived } = await snapshotTree(
    snapshotFromContext(context),
    latest,
    context.identity.actor,
  );
  const entry = derived.get(outcome.id);
  if (entry === undefined) {
    throw TaskError.internal(
      `${context.projects.qualify(latest, outcome.id)} is gone after its own transition.`,
      { id: outcome.id },
    );
  }

  const { command } = outcome;
  const cascading = (CASCADING_COMMANDS as readonly string[]).includes(command);
  const dependents =
    command === "cancel"
      ? await context.gates.dependentsOf(
          [outcome.id, ...outcome.reached].map((id) => ({ tree: latest, id })),
        )
      : null;
  const held = HOLDING_COMMANDS.has(command)
    ? descendantsOf(latest.tree, outcome.id).filter((task) =>
        isOpen(task.frontmatter.status),
      ).length
    : 0;

  return {
    command,
    task: entry.json,
    from: outcome.from,
    to: outcome.to,
    forced: outcome.forced,
    cascaded: cascading
      ? outcome.reached.map((id) => context.projects.qualify(latest, id))
      : null,
    dependents,
    holds: held > 0 ? held : null,
    superseded: outcome.superseded,
    unchanged: outcome.unchanged,
  };
}

/* ------------------------------------------------------------------------ */
/* Refusals                                                                 */
/* ------------------------------------------------------------------------ */

function statusList(statuses: readonly Status[]): string {
  if (statuses.length === OPEN_STATUSES.length) {
    if (OPEN_STATUSES.every((status) => statuses.includes(status))) {
      return "open";
    }
  }
  if (statuses.length <= 1) return statuses.join("");
  return `${statuses.slice(0, -1).join(", ")} or ${statuses[statuses.length - 1]}`;
}

function illegalTransition(run: Run, task: Task, to: Status): TaskError {
  const shown = run.shown(task.id);
  const from = task.frontmatter.status;
  const allowed = [...FROM[run.command]];
  const details: IllegalTransitionDetails = { id: shown, from, to, allowed };
  const applies = `${run.command} applies to ${statusList(allowed)} tasks`;
  const message =
    from === to && !FIELD_COMMANDS.has(run.command)
      ? `${shown} is already ${from}; ${applies}.`
      : `Cannot ${run.command} ${shown}: it is ${from}, and ${applies}.`;
  return TaskError.conflict(message, {
    ...details,
    kind: "illegal-transition",
  });
}

function alreadyClaimed(
  run: Run,
  task: Task,
  claimed: ClaimLiveness | null,
): TaskError {
  const shown = run.shown(task.id);
  const fm = task.frontmatter;
  const holder =
    fm.claimed_session === null
      ? `${fm.claimed_by} without a session`
      : `${fm.claimed_by} in session ${fm.claimed_session}`;
  return TaskError.conflict(
    `${shown} is already claimed by ${holder}, the claim this command would take.`,
    {
      ...authorizationDetailsOf(run.shown(task.id), task.frontmatter, claimed),
      kind: "already-claimed",
    },
  );
}

function blockedText(refs: StartGate["refs"]): string {
  return toBlockedBy(refs)
    .map((blocked) => `${blocked.ref} (${blocked.reason})`)
    .join(", ");
}

function startGateRefusal(run: Run, task: Task, start: StartGate): TaskError {
  const shown = run.shown(task.id);
  const details: StartGateDetails = {
    id: shown,
    blocked_by: toBlockedBy(start.refs),
  };
  const what = run.command === "done" ? "be done" : "be claimed";
  return TaskError.conflict(
    `${shown} cannot ${what}: its start gate is not satisfied, blocked by ${blockedText(start.refs)}. Pass --force to override.`,
    { ...details, kind: "start-gate" },
  );
}

function finishGateRefusal(
  run: Run,
  task: Task,
  finish: FinishGate,
): TaskError {
  const shown = run.shown(task.id);
  const details: FinishGateDetails = {
    id: shown,
    open_children: finish.open_children.map((id) => run.shown(id)),
    finishes_after: toBlockedBy(finish.refs),
  };
  const parts: string[] = [];
  if (details.open_children.length > 0) {
    parts.push(`open children ${details.open_children.join(", ")}`);
  }
  if (details.finishes_after.length > 0) {
    parts.push(`it finishes after ${blockedText(finish.refs)}`);
  }
  return TaskError.conflict(
    `${shown} cannot be done: ${parts.join("; ")}. Resolve them first; the finish gate cannot be forced.`,
    { ...details, kind: "finish-gate" },
  );
}

function ancestorDetails(
  run: Run,
  task: Task,
  ancestor: string,
): AncestorDetails {
  return { id: run.shown(task.id), ancestor: run.shown(ancestor) };
}

function holdRefusal(run: Run, task: Task, holder: Task): TaskError {
  const shown = run.shown(task.id);
  const ancestor = run.shown(holder.id);
  const fm = holder.frontmatter;
  const why =
    fm.claimed_by !== null || fm.status === "IN_PROGRESS"
      ? `claimed by ${fm.claimed_by ?? "nobody"}`
      : `assigned to ${fm.assignee}`;
  return TaskError.conflict(
    `${shown} is held by ${ancestor}, which is ${why}: its work or decision comes first. Pass --force to claim it anyway.`,
    { ...ancestorDetails(run, task, holder.id), kind: "held" },
  );
}

function stateRefusal(
  run: Run,
  task: Task,
  kind: StateDetails["kind"],
): TaskError {
  const shown = run.shown(task.id);
  const details: StateDetails = { id: shown, kind };
  if (kind === "missing-state") {
    const verb = run.command === "handoff" ? "handing it off" : "pausing";
    return TaskError.conflict(
      `${shown} is IN_PROGRESS and has no state.md; write it before ${verb} (\`tasks state ${shown}\` reads it from stdin).`,
      { ...details },
    );
  }
  return TaskError.conflict(
    `${shown} has a state.md, so the claim produced work; pause it instead of releasing it.`,
    { ...details },
  );
}

/**
 * The claims a cascade would reach, as its refusal names them; shared with
 * `move`, whose refusal over work in progress carries the same `claims`.
 */
export function claimsText(claims: CascadeClaimDetails["claims"]): string {
  return claims
    .map((claim) => {
      const session = claim.session === null ? "" : ` s:${claim.session}`;
      return `${claim.id} (claimed by ${claim.claimant}${session}, ${claim.liveness})`;
    })
    .join(", ");
}

function cascadeClaimRefusal(
  run: Run,
  task: Task,
  claims: CascadeClaimDetails["claims"],
): TaskError {
  const shown = run.shown(task.id);
  const details: CascadeClaimDetails = { id: shown, claims };
  return TaskError.conflict(
    `${run.command} ${shown} would reach work in progress: ${claimsText(claims)}. Wait for the claimant to pause, or pass --force.`,
    { ...details, kind: "cascade-claim" },
  );
}

function notAssigned(run: Run, task: Task): TaskError {
  const shown = run.shown(task.id);
  return TaskError.conflict(
    `${shown} is not assigned; there is nothing to unassign.`,
    { id: shown, kind: "not-assigned", assignee: null },
  );
}
