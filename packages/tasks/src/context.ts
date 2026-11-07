import path from "node:path";

import type { Command } from "commander";

import { assertListedActor, unlistedActorWarning } from "./core/actors.js";
import { detectTreeVersion } from "./core/config.js";
import type { DerivedTask } from "./core/derive.js";
import type { Project } from "./core/discovery.js";
import { requireProject } from "./core/discovery.js";
import { GateResolver } from "./core/gates.js";
import { assertTaskPath } from "./core/ids.js";
import type { LoadedTree, ProjectLoad } from "./core/projects.js";
import { Projects } from "./core/projects.js";
import {
  housekeepSessions,
  resolveIdentity,
  resolveSession,
  touchSession,
} from "./core/sessions.js";
import { snapshotFromContext, snapshotTree } from "./core/snapshot.js";
import type { Task } from "./core/task.js";
import type { Tree } from "./core/tree.js";
import {
  findTask,
  hasLiveTask,
  isGroup,
  loadTree,
  resolveTaskId,
} from "./core/tree.js";
import type { Identity } from "./core/types.js";
import {
  CONVENTION_VERSION,
  CONFIG_FILENAME,
  SESSION_ENV,
} from "./core/types.js";
import { TaskError } from "./errors.js";
import { ui, writeErr } from "./output.js";

/** The options every command accepts, declared once on the program. */
export interface GlobalOptions {
  dir?: string;
  as?: string;
  session?: string;
  json?: boolean;
}

export interface CommandContext {
  /** Where discovery started: `-C` or the working directory. */
  startDir: string;
  project: Project;
  /** The local tree as of its latest reload. */
  readonly tree: Tree;
  projects: Projects;
  gates: GateResolver;
  identity: Identity;
  json: boolean;
  /** Print a warning on stderr: a condition the command survives. */
  diagnose(message: string): void;
  /** Re-read the local tree from disk and drop cached gate resolutions. */
  reload(): Promise<void>;
  /** The local tree first, then every listed tree that is available. */
  trees(): Promise<LoadedTree[]>;
}

/** Program-level options as seen from a subcommand's action. */
export function globalOptions(command: Command): GlobalOptions {
  const merged = command.optsWithGlobals() as GlobalOptions;
  return {
    dir: merged.dir,
    as: merged.as,
    session: merged.session,
    json: merged.json,
  };
}

export function startDirectory(options: GlobalOptions): string {
  return path.resolve(options.dir ?? process.cwd());
}

/** Identity without a tree: what `init` needs before anything exists. */
export async function resolveCommandIdentity(
  options: GlobalOptions,
  projectRoot: string,
): Promise<Identity> {
  return resolveIdentity({
    as: options.as,
    session: options.session,
    projectRoot,
    diagnose: (message) => writeErr(ui.warn(message)),
  });
}

/**
 * Refuse to operate on a tree that is not v2. A v1 tree names the upgrade;
 * `migrate` is the one command that opens it, through its own path.
 */
export async function assertV2Tree(project: Project): Promise<void> {
  const detected = await detectTreeVersion(project.tasksDir);
  if (detected.kind === "v2") return;
  if (detected.kind === "v1") {
    throw TaskError.usage(
      `${project.tasksDir} is a .tasks v1 tree. Run \`tasks migrate\` once to upgrade it to v${CONVENTION_VERSION}; every other command refuses a v1 tree.`,
      { tasksDir: project.tasksDir, version: 1, upgrade: "tasks migrate" },
    );
  }
  throw TaskError.usage(
    `${path.join(project.tasksDir, CONFIG_FILENAME)}: version ${detected.version} is not supported; this tasks implements .tasks convention v${CONVENTION_VERSION}.`,
    { tasksDir: project.tasksDir, version: detected.version },
  );
}

/**
 * Open the workspace for a command: discovery from `-C`, the version check,
 * the local tree, the projects it lists, the acting identity, and the
 * heartbeat that every command with a session writes before its own work.
 */
export async function openContext(command: Command): Promise<CommandContext> {
  const options = globalOptions(command);
  const startDir = startDirectory(options);
  const project = await requireProject(startDir);
  await assertV2Tree(project);

  const identity = await resolveCommandIdentity(options, project.root);
  const projects = new Projects(await loadTree(project));
  checkRoster(projects.local.tree, identity, options.as, options.json === true);
  const gates = new GateResolver(projects);

  if (identity.session) {
    await heartbeat(projects, identity.session);
  }

  const context: CommandContext = {
    startDir,
    project,
    // Always the latest snapshot: a mutation that reloads through `projects`
    // is seen here without a second bookkeeping step.
    get tree() {
      return projects.local.tree;
    },
    projects,
    gates,
    identity,
    json: options.json === true,
    diagnose: (message) => writeErr(ui.warn(message)),
    async reload() {
      await projects.reload(projects.local);
      gates.invalidate();
    },
    async trees() {
      return projects.writableTrees();
    },
  };
  return context;
}

/**
 * The local roster against the acting identity. `--as` names someone else,
 * so a name it does not list is refused like any other typed actor; the
 * identity resolved from the environment is this command's own and is only
 * diagnosed, since the remedy lies in `TASKS_ACTOR` or in `config.yml`, not
 * on the command line. With an `--as`, the operator behind it is the one
 * resolved from the environment, and it is diagnosed the same way. Under
 * `--json` stderr stays reserved for the error envelope: `actors --json`
 * carries the same fact as `listed: false` on the caller's row.
 */
function checkRoster(
  tree: Tree,
  identity: Identity,
  as: string | null | undefined,
  json: boolean,
): void {
  const { config, project } = tree;
  const overridden = as !== undefined && as !== null;
  if (overridden) assertListedActor(config, project, identity.actor, "--as");
  if (json) return;
  const operator = overridden ? identity.via : identity.actor;
  if (operator === null) return;
  const warning = unlistedActorWarning(
    config,
    project,
    operator,
    overridden ? "operator" : "actor",
  );
  if (warning !== null) writeErr(ui.warn(warning));
}

/**
 * Touch the session's registry file in the local tree and in every listed
 * tree that is checked out, then tidy the local registry. Liveness of a
 * claim is judged by the registry of the tree that holds the task, which is
 * why one command reaches every tree it can see.
 */
export async function heartbeat(
  projects: Projects,
  session: string,
): Promise<string[]> {
  const touched: string[] = [];
  for (const load of await projects.writableTrees()) {
    await touchSession(load.project.tasksDir, session);
    touched.push(load.project.tasksDir);
  }
  await housekeepSessions(projects.local.tree);
  return touched;
}

/**
 * The heartbeat of a command that does not open the tree (`skill install`,
 * `hooks install`): the one every other command writes, into the tree at
 * `project` and every tree it lists, when it is a v2 tree. A v1 or
 * unsupported tree has no registry to touch; no session, no heartbeat.
 */
export async function heartbeatAt(
  project: Project,
  session: string | null,
): Promise<void> {
  if (session === null) return;
  if ((await detectTreeVersion(project.tasksDir)).kind !== "v2") return;
  await heartbeat(new Projects(await loadTree(project)), session);
}

/* ------------------------------------------------------------------------ */
/* Helpers the commands share                                               */
/* ------------------------------------------------------------------------ */

/**
 * The session a session command (`heartbeat`, `session-end`) acts for:
 * `--session`, else `TASKS_SESSION`. Checked before the tree is opened, so a
 * call without one is refused without touching the disk.
 */
export function requireSession(command: Command, name: string): string {
  const session = resolveSession({ session: globalOptions(command).session });
  if (session === null) {
    throw TaskError.usage(
      `${name} needs a session: pass --session <token> or set ${SESSION_ENV}.`,
      { command: name, env: SESSION_ENV },
    );
  }
  return session;
}

/** `--scope`, `--all`: how a scoped query names its local scope. */
export interface ScopeOptions {
  scope?: string;
  all?: boolean;
}

/** A live task, a malformed one, or a group of the tree sits at `id`. */
function namesTreePath(tree: Tree, id: string): boolean {
  return hasLiveTask(tree, id) || isGroup(tree, id);
}

/**
 * The local scope of `ready`, `list` and `tree`: `--scope` when given, none
 * under `--all`, else the configured `scope`. A scope is a path of the local
 * tree and applies to it alone; listed projects are never scoped.
 *
 * An explicit `--scope` must name a task or group of the local tree, so a
 * typo fails instead of answering with a silent empty set. A configured
 * scope that names nothing (its epic was archived or moved) is applied as
 * written, with a diagnostic, so `config.yml` gets fixed rather than every
 * overview failing until it is.
 */
export function resolveScope(
  context: CommandContext,
  options: ScopeOptions,
): string | null {
  if (options.scope !== undefined) {
    if (options.all) {
      throw TaskError.usage(
        "--scope and --all contradict each other: --all lifts the scope that --scope sets.",
        { scope: options.scope },
      );
    }
    const scope = assertTaskPath(options.scope, "scope");
    if (!namesTreePath(context.tree, scope)) {
      throw TaskError.notFound(
        `No task or group "${scope}" in ${context.project.tasksDir}; a scope is a path of the local tree.`,
        { scope },
      );
    }
    return scope;
  }
  if (options.all) return null;

  const configured = context.tree.config.scope;
  if (configured !== null && !namesTreePath(context.tree, configured)) {
    context.diagnose(
      `scope "${configured}" in ${path.join(context.project.tasksDir, CONFIG_FILENAME)} names no task or group of this tree; no local task is in scope.`,
    );
  }
  return configured;
}

/**
 * The tree behind a command-line alias, or the error that says why there is
 * none: an absent checkout is not found, a v1 or unsupported tree is refused
 * like a local one, and an unreadable configuration reports its own error.
 */
function availableTree(target: ProjectLoad): LoadedTree {
  if (target.kind === "ok") return target;
  const name = target.alias ?? target.relPath;
  const details = { alias: target.alias, path: target.relPath };
  switch (target.kind) {
    case "not-checked-out":
      throw TaskError.notFound(
        `Project ${name} (${target.relPath}) is not checked out: ${target.dir} does not exist.`,
        { ...details, reason: "not-checked-out" },
      );
    case "unsupported-version":
      if (target.version === 1) {
        throw TaskError.usage(
          `Project ${name} is a .tasks v1 tree. Run \`tasks migrate ${name}\` once to upgrade it to v${CONVENTION_VERSION}.`,
          { ...details, version: 1, upgrade: `tasks migrate ${name}` },
        );
      }
      throw TaskError.usage(
        `Project ${name} declares .tasks version ${target.version}, which is not supported; this tasks implements v${CONVENTION_VERSION}.`,
        { ...details, version: target.version },
      );
    case "unresolved":
      if (target.cause !== null) throw target.cause;
      throw TaskError.notFound(
        `Project ${name} (${target.relPath}) has no .tasks/ tree at ${target.dir}.`,
        { ...details, reason: "unresolved-project" },
      );
  }
}

/**
 * Resolve a path or suffix inside one tree, as `resolveTaskId` does, with
 * candidates and messages qualified by the tree's alias: in a listed project
 * the ids the user must type next carry it.
 */
function resolveIdIn(
  projects: Projects,
  load: LoadedTree,
  rest: string,
  argument: string,
): string {
  return resolveTaskId(load.tree, rest, {
    argument,
    qualify: (id) => projects.qualify(load, id),
  });
}

/** A `<task>` argument, resolved: the tree that holds it and the task. */
export interface TaskTarget {
  load: LoadedTree;
  task: Task;
}

/**
 * Resolve a `<task>` argument: `alias:path` in a listed project, a bare path
 * in the local tree only, each by the suffix rule. Ambiguity is a usage
 * error naming the candidates, a path that exists only under `.archive/` is
 * not found, and a malformed manifest is a conflict naming the file.
 */
export async function resolveTaskArgument(
  context: CommandContext,
  arg: string,
): Promise<TaskTarget> {
  const { target, path: rest } = await context.projects.resolveArgument(arg);
  const load = availableTree(target);
  const id = resolveIdIn(context.projects, load, rest, arg);
  return { load, task: findTask(load.tree, id) };
}

/**
 * Every task of `load` derived for the calling actor, and `id` among them.
 * Derivation reads the whole tree, since a task's conditions depend on its
 * ancestors, children and references.
 */
export async function deriveWithin(
  context: CommandContext,
  load: LoadedTree,
  id: string,
): Promise<{ task: DerivedTask; derived: Map<string, DerivedTask> }> {
  const { derived } = await snapshotTree(
    snapshotFromContext(context),
    load,
    context.identity.actor,
  );
  const task = derived.get(id);
  if (task === undefined) {
    throw TaskError.internal(`${id} was resolved but not derived.`, { id });
  }
  return { task, derived };
}
