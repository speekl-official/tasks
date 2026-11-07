/**
 * The shared vocabulary of the `.tasks` convention v2.
 *
 * Every module codes against the names here: the fixed lifecycle, the
 * derived conditions, the situation words, the gate reasons, and the JSON
 * objects the CLI contract draws. Nothing in this file touches the disk.
 * Behaviour lives in the modules; this file is what lets them agree.
 */

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                */
/* ------------------------------------------------------------------------ */

export const STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "PAUSED",
  "DONE",
  "CANCELLED",
] as const;

export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: readonly Status[] = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "PAUSED",
];

export const RESOLVED_STATUSES: readonly Status[] = ["DONE", "CANCELLED"];

export function isStatus(value: unknown): value is Status {
  return (
    typeof value === "string" && (STATUSES as readonly string[]).includes(value)
  );
}

export function isOpen(status: Status): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isResolved(status: Status): boolean {
  return RESOLVED_STATUSES.includes(status);
}

/* ------------------------------------------------------------------------ */
/* Priority                                                                 */
/* ------------------------------------------------------------------------ */

/** Highest first: the order of the ready set. */
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export type Priority = (typeof PRIORITIES)[number];

export const DEFAULT_PRIORITY: Priority = "normal";

/** Lower rank sorts first. */
export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function isPriority(value: unknown): value is Priority {
  return (
    typeof value === "string" &&
    (PRIORITIES as readonly string[]).includes(value)
  );
}

/** The higher of two levels; how effective priority folds over ancestors. */
export function higherPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

/* ------------------------------------------------------------------------ */
/* Patterns and names                                                       */
/* ------------------------------------------------------------------------ */

/** A group or task directory name, and a project alias. */
export const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** An actor or a session token. */
export const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

export const TASKS_DIRNAME = ".tasks";
export const ARCHIVE_DIRNAME = ".archive";
export const LOCKS_DIRNAME = ".locks";
export const SESSIONS_DIRNAME = "sessions";
export const TREE_LOCK_FILENAME = "tree.lock";

export const CONFIG_FILENAME = "config.yml";
export const README_FILENAME = "README.md";
export const GITIGNORE_FILENAME = ".gitignore";
export const INDEX_FILENAME = "index.md";

export const TASK_FILENAME = "task.md";
export const STATE_FILENAME = "state.md";
export const DESIGN_FILENAME = "design.md";
export const PLAN_FILENAME = "plan.md";
export const LOG_FILENAME = "log.md";

/**
 * Written into a destination directory while a subtree is copied across
 * filesystems (its content names the source path); removed when the copy and
 * the removal of the source are complete. A surviving marker is how a task
 * present twice is told from two unrelated tasks.
 */
export const MOVING_MARKER_FILENAME = ".moving";

/** The workspace vocabulary beside `task.md`, in reading order. */
export const WORKSPACE_FILENAMES = [
  STATE_FILENAME,
  DESIGN_FILENAME,
  PLAN_FILENAME,
  LOG_FILENAME,
] as const;

export type WorkspaceFilename = (typeof WORKSPACE_FILENAMES)[number];

/** Files reserved at the root of `.tasks/`; a directory of that name is not. */
export const ROOT_FILENAMES = [
  CONFIG_FILENAME,
  README_FILENAME,
  GITIGNORE_FILENAME,
  INDEX_FILENAME,
] as const;

export const CONVENTION_VERSION = 2;

export const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

/** Reference staleness threshold of the tree lock. */
export const LOCK_STALE_MS = 10_000;

/* ------------------------------------------------------------------------ */
/* Environment                                                              */
/* ------------------------------------------------------------------------ */

export const ACTOR_ENV = "TASKS_ACTOR";
export const SESSION_ENV = "TASKS_SESSION";

/** The conventional actor of an agent: what the hooks export and the skill sets. */
export const AGENT_ACTOR = "agent";
export const AGENT_DESCRIPTION = "the coding agent";

/* ------------------------------------------------------------------------ */
/* The manifest                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The ten fields of `task.md`, in canonical order. Timestamps are ISO 8601
 * UTC at second precision with a `Z` suffix, kept as strings end to end.
 */
export interface Frontmatter {
  status: Status;
  priority: Priority;
  depends_on: string[];
  finishes_after: string[];
  assignee: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_session: string | null;
  created: string;
  updated: string;
}

export const FRONTMATTER_KEYS: readonly (keyof Frontmatter)[] = [
  "status",
  "priority",
  "depends_on",
  "finishes_after",
  "assignee",
  "claimed_by",
  "claimed_at",
  "claimed_session",
  "created",
  "updated",
];

/** Keys read from a manifest that this revision does not define. */
export type ExtraKeys = ReadonlyArray<readonly [key: string, value: unknown]>;

/* ------------------------------------------------------------------------ */
/* Gates                                                                    */
/* ------------------------------------------------------------------------ */

export const GATE_REASONS = [
  "not-done",
  "cancelled",
  "missing",
  "archived",
  "malformed",
  "unresolved-project",
  "not-checked-out",
  "unsupported-version",
] as const;

export type GateReason = (typeof GATE_REASONS)[number];

/**
 * One reference, resolved. `ref` is the stored form; `project` is the alias
 * when the target tree is a listed project, `null` for the local tree, and
 * the project path relative to the local root for a tree reached without an
 * alias. `satisfied` follows the gate the reference was resolved for: the
 * start gate in `StartGate.refs` (`DONE` only), the finish gate in
 * `FinishGate.refs` (`DONE` or `CANCELLED`).
 */
export interface ResolvedRef {
  ref: string;
  project: string | null;
  /** The target id inside its own tree. */
  id: string;
  satisfied: boolean;
  /** `null` when satisfied. */
  reason: GateReason | null;
  /** The target's status when it is live and parses, else `null`. */
  status: Status | null;
}

/** An unsatisfied reference as the JSON `blocked_by` list carries it. */
export interface BlockedByJson {
  ref: string;
  reason: GateReason;
  status: Status | null;
}

export interface StartGate {
  satisfied: boolean;
  refs: ResolvedRef[];
}

export interface FinishGate {
  satisfied: boolean;
  /** Ids of live open children. */
  open_children: string[];
  /** `finishes_after`, resolved. */
  refs: ResolvedRef[];
}

/* ------------------------------------------------------------------------ */
/* Sessions and liveness                                                    */
/* ------------------------------------------------------------------------ */

export type Liveness = "live" | "orphaned" | "unknown";

export interface ClaimLiveness {
  liveness: Liveness;
  /** Last heartbeat of the claimant's session, or `null` when none exists. */
  last_seen: string | null;
}

/** Who acts: the principal, and the operator when acting on their behalf. */
export interface Identity {
  actor: string;
  /** Set when `--as` named someone other than the resolved operator. */
  via: string | null;
  session: string | null;
}

/* ------------------------------------------------------------------------ */
/* Derived conditions and situations                                        */
/* ------------------------------------------------------------------------ */

/**
 * The one word an overview says, in precedence order. `held`, `waiting`,
 * `assigned`, `blocked` and `open` carry their object in a separate field.
 */
export const SITUATIONS = [
  "done",
  "cancelled",
  "working",
  "parked",
  "backlog",
  "held",
  "waiting",
  "assigned",
  "blocked",
  "closable",
  "open",
  "ready",
] as const;

export type Situation = (typeof SITUATIONS)[number];

export interface ChildrenProgress {
  open: number;
  resolved: number;
}

/**
 * Computed on every query, never stored. These are the fields the reporting
 * commands add to the task object.
 */
export interface Derived {
  situation: Situation;
  blocked_by: BlockedByJson[];
  /** For the calling actor. */
  ready: boolean;
  effective_priority: Priority;
  /** The nearest claimed or assigned ancestor, or `null`. */
  held_by: string | null;
  /** A `state.md` exists on the task or on a descendant. */
  started: boolean;
  children: ChildrenProgress;
  /** An `IN_PROGRESS` descendant exists. */
  active: boolean;
  /** The assignee of a `PAUSED` task, else `null`. */
  waiting_for: string | null;
  /** An open parent whose finish gate is satisfied. */
  closable: boolean;
  /** `IN_PROGRESS` only; `null` otherwise. */
  liveness: Liveness | null;
  /** `IN_PROGRESS` with a session only; `null` otherwise. */
  last_seen: string | null;
  last_entry: LastEntryJson | null;
}

/* ------------------------------------------------------------------------ */
/* Log entries                                                              */
/* ------------------------------------------------------------------------ */

export interface LogEntryJson {
  /** Qualified with its alias for a foreign tree. */
  task: string;
  time: string;
  actor: string;
  via: string | null;
  session: string | null;
  /** The body below the heading. */
  text: string;
}

export type LastEntryJson = Omit<LogEntryJson, "task">;

export interface LogEntriesJson {
  count: number;
  entries: LogEntryJson[];
}

/* ------------------------------------------------------------------------ */
/* Task and collection objects                                              */
/* ------------------------------------------------------------------------ */

export interface TaskJson extends Frontmatter {
  id: string;
  name: string;
  parent: string | null;
  /** The alias of the task's tree, or `null` for the local tree. */
  project: string | null;
  title: string;
  /** Absolute path of the task directory. */
  path: string;
}

export type TaskWithDerivedJson = TaskJson & Derived;

export interface MalformedJson {
  path: string;
  message: string;
}

/** A listed project an overview could not read, and why. */
export interface UnavailableProjectJson {
  alias: string;
  /** `not-checked-out`, `unresolved-project` or `unsupported-version`. */
  reason: GateReason;
}

export interface CollectionJson<T = TaskWithDerivedJson> {
  /** The resolved local scope, or `null`. */
  scope: string | null;
  /** The aliases spanned. */
  projects: string[];
  count: number;
  tasks: T[];
  malformed: MalformedJson[];
  /** Listed projects left out because they could not be read. */
  unavailable: UnavailableProjectJson[];
}

/** One row of `actors`: a listed actor, or one that an open task names. */
export interface ActorJson {
  actor: string;
  /** The line `config.yml` gives the actor; `null` without one, or unlisted. */
  description: string | null;
  /** Whether `config.yml` lists the actor under `actors:`. */
  listed: boolean;
  /** Open tasks the actor is working on: `claimed_by`. */
  claimed: number;
  /** Open tasks the actor must act on: `assignee`. */
  assigned: number;
}

export interface ActorsJson {
  /** The calling actor and its operator, as `init` reports them. */
  actor: string;
  via: string | null;
  /** The aliases spanned for the counts. */
  projects: string[];
  /** Listed actors in configured order, then the others by name. */
  actors: ActorJson[];
  unavailable: UnavailableProjectJson[];
}

/* ------------------------------------------------------------------------ */
/* Validation, session-check, session-end                                   */
/* ------------------------------------------------------------------------ */

export type FindingSeverity = "error" | "warning";

export const FINDING_KINDS = [
  "malformed",
  "unknown-status",
  "unknown-priority",
  "claim-fields",
  "malformed-ref",
  "cycle",
  "ancestor-dependency",
  "resolved-with-open-descendant",
  "backlog-invariant",
  "archived-path-conflict",
  "duplicate-id",
  "log-conflict-markers",
  "paused-without-state",
  "todo-with-state",
  "unsatisfiable-ref",
  "claim-liveness",
  "unknown-key",
  "unknown-actor",
  "project-unavailable",
  "duplicate-project",
  "resolved-unarchived",
  "index-stale",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export interface FindingJson {
  severity: FindingSeverity;
  kind: FindingKind;
  /** The task concerned, or `null` for a tree-level finding. */
  task: string | null;
  message: string;
}

export interface ValidationJson {
  /** `false` iff at least one finding has error severity. */
  ok: boolean;
  checked: number;
  /** What `--fix` regenerated; only ever `index.md`. */
  fixed: string[];
  findings: FindingJson[];
}

export type StateKind = "missing-state" | "present-state";

export interface SessionViolationJson {
  id: string;
  kind: "missing-state";
}

export type SessionWarningKind =
  | "state-older-than-claim"
  | "state-older-than-log";

export interface SessionWarningJson {
  id: string;
  kind: SessionWarningKind;
  message: string;
}

export interface SessionCheckJson {
  ok: boolean;
  session: string | null;
  violations: SessionViolationJson[];
  warnings: SessionWarningJson[];
}

export interface SessionEndJson {
  session: string;
  ended: string;
  /** Ids of the tasks whose claims were orphaned. */
  claims: string[];
}

/* ------------------------------------------------------------------------ */
/* Errors                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The structured facts an error's `details` carries, by failure. Every
 * module throws `TaskError` with one of these so that callers can branch on
 * `details` instead of on `message`.
 */
export interface IllegalTransitionDetails {
  id: string;
  from: Status;
  to: Status;
  allowed: Status[];
}

export interface AuthorizationDetails {
  id: string;
  claimed_by: string | null;
  claimed_session: string | null;
  assignee: string | null;
  liveness: Liveness | null;
}

export interface StartGateDetails {
  id: string;
  blocked_by: BlockedByJson[];
}

export interface FinishGateDetails {
  id: string;
  open_children: string[];
  finishes_after: BlockedByJson[];
}

export interface CascadeClaimDetails {
  id: string;
  claims: Array<{
    id: string;
    claimant: string;
    session: string | null;
    liveness: Liveness;
  }>;
}

export interface AncestorDetails {
  id: string;
  ancestor: string;
}

export interface StateDetails {
  id: string;
  kind: StateKind;
}

export interface AmbiguousDetails {
  argument: string;
  candidates: string[];
}

export interface DependentsDetails {
  id: string;
  dependents: string[];
}

export interface SessionCheckDetails {
  violations: SessionViolationJson[];
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                 */
/* ------------------------------------------------------------------------ */

export const TRANSITION_COMMANDS = [
  "schedule",
  "defer",
  "claim",
  "pause",
  "release",
  "done",
  "cancel",
  "reopen",
  "handoff",
  "assign",
  "unassign",
  "priority",
] as const;

export type TransitionCommand = (typeof TRANSITION_COMMANDS)[number];

/** The transitions that reach the subtree. */
export const CASCADING_COMMANDS: readonly TransitionCommand[] = [
  "defer",
  "schedule",
  "cancel",
];

/** How a tree listed or referenced from here loaded; see `core/projects.ts`. */
export type ProjectState =
  | "ok"
  | "not-checked-out"
  | "unresolved"
  | "unsupported-version";

/** The two fields that hold references. */
export type GateField = "depends_on" | "finishes_after";

/** A reference a command could not rewrite. */
export interface UnrewrittenRefJson {
  /**
   * The alias or project path of the tree holding the reference; `null` for
   * the local tree.
   */
  project: string | null;
  task: string;
  field: GateField;
  ref: string;
}

export interface RewrittenRefJson {
  /** `null` for the local tree. */
  project: string | null;
  task: string;
  field: GateField;
  from: string;
  to: string;
}
