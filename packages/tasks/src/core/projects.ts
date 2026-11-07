import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { TaskError, isTaskError } from "../errors.js";
import type { TreeVersion } from "./config.js";
import { detectTreeVersion, projectPathOf } from "./config.js";
import type { Project } from "./discovery.js";
import { findProject } from "./discovery.js";
import { errnoCode, isDirectory } from "./fs-utils.js";
import { isMachineBoundPath, qualifyId, splitTaskArgument } from "./ids.js";
import type { Tree } from "./tree.js";
import { loadTree } from "./tree.js";
import { CONFIG_FILENAME, TASKS_DIRNAME } from "./types.js";

/**
 * The trees one command can see: the local tree, the trees it lists under
 * `projects:`, and trees that a stored reference reaches by a bare relative
 * path. Other trees load lazily, once per command, and every tree has one
 * identity — the realpath of its project root — however a path reaches it:
 * an alias, a reference stored in another tree, a symlink.
 *
 * `projects:` is not transitive. The aliases of a listed tree extend nothing
 * here; they are read only to classify that tree's own references.
 */

/** A tree that loaded. */
export interface LoadedTree {
  readonly kind: "ok";
  /**
   * The alias in the local tree's `projects:`, or `null` for the local tree
   * and for a tree reached by a bare path. A tree listed under two aliases
   * has one identity and carries the first alias in configuration order.
   */
  readonly alias: string | null;
  /** True for the local tree. */
  readonly local: boolean;
  /** The local tree, or a tree it lists. A bare-path tree is read-only. */
  readonly writable: boolean;
  /** The realpath of the project root: the tree's identity. */
  readonly key: string;
  /**
   * Where the tree lives. Another tree's root is its realpath, so the
   * references it stores resolve as they do from inside its own checkout.
   */
  readonly project: Project;
  readonly tree: Tree;
}

interface UnavailableFields {
  /** The alias in the local tree's `projects:` naming this place, or `null`. */
  alias: string | null;
  /** The path as given: the configured path, or the stored project path. */
  relPath: string;
  /** The absolute directory it resolved to. */
  dir: string;
}

/** A configured project whose directory is absent on this machine. */
export interface NotCheckedOut extends UnavailableFields {
  kind: "not-checked-out";
}

/**
 * Discovery finds no tree from the directory (`cause` is `null`), or finds
 * one that cannot be read: an invalid `config.yml` (the usage error loading
 * it would raise) or a directory the scan cannot enter.
 */
export interface Unresolved extends UnavailableFields {
  kind: "unresolved";
  cause: TaskError | null;
}

/** A v1 tree (`version` 1) or one of a version this implementation lacks. */
export interface UnsupportedVersion extends UnavailableFields {
  kind: "unsupported-version";
  version: number;
}

export type UnavailableTree = NotCheckedOut | Unresolved | UnsupportedVersion;

export type ProjectLoad = LoadedTree | UnavailableTree;

/** What lies at a directory, before any tree is read. */
type DirState =
  | { kind: "absent" }
  | { kind: "no-tree" }
  | { kind: "tree"; key: string };

/** What a discovered tree root turned out to be. */
type RootState =
  | { kind: "ok" }
  | { kind: "unsupported-version"; version: number }
  | { kind: "unresolved"; cause: TaskError };

export class Projects {
  private current: LoadedTree;
  /** The latest snapshot of every tree that loaded, by key. */
  private readonly trees = new Map<string, LoadedTree>();
  private readonly dirs = new Map<string, Promise<DirState>>();
  private readonly roots = new Map<string, Promise<RootState>>();

  constructor(local: Tree) {
    const key = realpathOrResolved(local.project.root);
    this.current = {
      kind: "ok",
      alias: null,
      local: true,
      writable: true,
      key,
      project: local.project,
      tree: local,
    };
    this.trees.set(key, this.current);
    this.roots.set(key, Promise.resolve({ kind: "ok" }));
  }

  /** The local tree, as of its latest `reload`. */
  get local(): LoadedTree {
    return this.current;
  }

  /** The configured aliases, in configuration order. */
  aliases(): string[] {
    return Object.keys(this.current.tree.config.projects);
  }

  /** The project listed as `alias`. An unknown alias is a usage error. */
  async byAlias(alias: string): Promise<ProjectLoad> {
    const relPath = this.configuredPath(alias);
    const load = await this.byPath(this.current, relPath);
    if (load.kind === "ok") {
      if (load.local) throw this.selfAlias(alias, relPath);
      return load;
    }
    // Unavailable results are built per call: name the alias asked for.
    return { ...load, alias };
  }

  /** Every configured project, aligned with `aliases()`. */
  async listed(): Promise<ProjectLoad[]> {
    return Promise.all(this.aliases().map((alias) => this.byAlias(alias)));
  }

  /**
   * The tree a project path stored in `holder` leads to: resolved against
   * the holder's project root, then discovery. A path that reaches the local
   * tree yields `local`; one that reaches a listed tree yields that tree,
   * alias and all. An absent directory is not checked out when the local
   * tree or the holder lists it, and unresolved otherwise.
   */
  async byPath(holder: LoadedTree, relPath: string): Promise<ProjectLoad> {
    if (relPath.length === 0 || isMachineBoundPath(relPath)) {
      throw TaskError.usage(
        `Invalid project path "${relPath}": expected a path relative to the project root.`,
        { path: relPath },
      );
    }
    const dir = path.resolve(holder.key, relPath);
    const state = await this.dirState(dir);
    if (state.kind === "tree") return this.treeAt(state.key, relPath, dir);

    const alias = await this.aliasOfDir(dir);
    if (
      state.kind === "absent" &&
      (alias !== null || (await this.holderLists(holder, dir)))
    ) {
      return { kind: "not-checked-out", alias, relPath, dir };
    }
    return { kind: "unresolved", alias, relPath, dir, cause: null };
  }

  /**
   * A command-line task argument: `alias:path` addresses a listed project,
   * a bare path the local tree. The path is returned as typed; suffixes are
   * resolved by the caller against the target's tree.
   */
  async resolveArgument(
    arg: string,
  ): Promise<{ target: ProjectLoad; path: string }> {
    const { prefix, path: rest } = splitTaskArgument(arg);
    if (prefix === null) return { target: this.current, path: rest };
    return { target: await this.byAlias(prefix), path: rest };
  }

  /**
   * The form in which `holder` stores a reference to `id` in `target`: the
   * bare id within one tree; otherwise `<project-path>:<id>`, where the
   * project path is the configured alias path when the holder is the local
   * tree and the target is listed, and the relative path between the two
   * project roots in every other case.
   */
  storedReference(holder: LoadedTree, target: LoadedTree, id: string): string {
    if (holder.key === target.key) return id;
    if (holder.key === this.current.key && target.alias !== null) {
      const configured = projectPathOf(this.current.tree.config, target.alias);
      if (configured !== undefined) return `${configured}:${id}`;
    }
    const relative = relativeProjectPath(holder.key, target.key);
    if (relative === null) {
      throw TaskError.usage(
        `${target.project.root} cannot be referenced from ${holder.project.root}: no relative path joins them.`,
        { from: holder.project.root, to: target.project.root, id },
      );
    }
    return `${relative}:${id}`;
  }

  /**
   * How output names a tree: `null` for the local tree, the alias for a
   * listed one, and for a bare-path tree its path relative to the local
   * project root, which is also how the local tree would store it.
   */
  qualifier(load: LoadedTree): string | null {
    if (load.key === this.current.key) return null;
    if (load.alias !== null) return load.alias;
    return (
      relativeProjectPath(this.current.key, load.key) ??
      load.key.split(path.sep).join("/")
    );
  }

  /** `id` for the local tree, `alias:id` or `<relative-path>:id` otherwise. */
  qualify(load: LoadedTree, id: string): string {
    return qualifyId(this.qualifier(load), id);
  }

  /** The most recent snapshot of the same tree. */
  latest(load: LoadedTree): LoadedTree {
    return this.trees.get(load.key) ?? load;
  }

  /**
   * Re-read a tree from disk, after a write, and make the result the
   * snapshot every later lookup sees. The configuration is kept: no command
   * that works through this class rewrites `config.yml`.
   */
  async reload(load: LoadedTree): Promise<LoadedTree> {
    const tree = await loadTree(load.project, { config: load.tree.config });
    const fresh: LoadedTree = { ...this.latest(load), tree };
    this.trees.set(load.key, fresh);
    if (load.key === this.current.key) this.current = fresh;
    return fresh;
  }

  /**
   * The trees a command fans out over (registry touch, `log --since`, move
   * rewriting): the local tree first, then every listed tree that loaded, in
   * configuration order, each once.
   */
  async writableTrees(): Promise<LoadedTree[]> {
    const out: LoadedTree[] = [this.current];
    const seen = new Set([this.current.key]);
    for (const load of await this.listed()) {
      if (load.kind !== "ok" || seen.has(load.key)) continue;
      seen.add(load.key);
      out.push(this.latest(load));
    }
    return out;
  }

  /**
   * Every tree that loaded during this command — the local tree first, then
   * listed trees and trees a stored reference reached by a bare path, in the
   * order they loaded — each as of its latest reload. `move` reads the
   * read-only ones among them for references it can report but not rewrite.
   */
  knownTrees(): LoadedTree[] {
    return [...this.trees.values()];
  }

  /* ---------------------------------------------------------------------- */

  private configuredPath(alias: string): string {
    const relPath = projectPathOf(this.current.tree.config, alias);
    if (relPath === undefined) {
      const aliases = this.aliases();
      const known =
        aliases.length === 0
          ? "this tree lists no projects"
          : `the configured aliases are ${aliases.join(", ")}`;
      throw TaskError.usage(
        `Unknown project alias "${alias}": ${known}.${this.pathHint(alias, aliases)}`,
        { alias, aliases },
      );
    }
    return relPath;
  }

  /**
   * The stored form of a reference (`../backend:x`) is not accepted on the
   * command line, where a project is named by alias; say so when the
   * "alias" looks like a path, naming the alias that path has when it has one.
   */
  private pathHint(alias: string, aliases: string[]): string {
    if (!alias.includes("/") && !alias.startsWith(".")) return "";
    const named = aliases.find(
      (candidate) =>
        projectPathOf(this.current.tree.config, candidate) === alias,
    );
    return named === undefined
      ? " On the command line a project is named by its alias; the path form is how references are stored in files."
      : ` On the command line a project is named by its alias: that path is project ${named}, so write ${named}:<path>.`;
  }

  /**
   * `config.ts` refuses such an alias when the tree loads; this guards a
   * directory that appeared since, so a listed project is never the local
   * tree under another name.
   */
  private selfAlias(alias: string, relPath: string): TaskError {
    const file = path.join(this.current.project.tasksDir, CONFIG_FILENAME);
    return TaskError.usage(
      `${file}: project "${alias}" (${relPath}) resolves to this tree itself; an alias must name another tree.`,
      { file, key: "projects", alias, path: relPath },
    );
  }

  private dirState(dir: string): Promise<DirState> {
    return memo(this.dirs, dir, async () => {
      if (!(await isDirectory(dir))) return { kind: "absent" };
      const found = await findProject(dir);
      if (found === null) return { kind: "no-tree" };
      return { kind: "tree", key: await canonical(found.root) };
    });
  }

  private async treeAt(
    key: string,
    relPath: string,
    dir: string,
  ): Promise<ProjectLoad> {
    const state = await this.rootState(key);
    if (state.kind === "ok") return this.trees.get(key)!;
    const alias = await this.aliasOfKey(key);
    return state.kind === "unsupported-version"
      ? {
          kind: "unsupported-version",
          alias,
          relPath,
          dir,
          version: state.version,
        }
      : { kind: "unresolved", alias, relPath, dir, cause: state.cause };
  }

  /**
   * Classify and load the tree at a root, once. A v1 or unsupported tree is
   * classified, never thrown: a foreign tree that cannot be read blocks the
   * references into it, it does not abort the command.
   */
  private rootState(key: string): Promise<RootState> {
    return memo(this.roots, key, async () => {
      const project: Project = {
        root: key,
        tasksDir: path.join(key, TASKS_DIRNAME),
      };
      let version: TreeVersion;
      try {
        version = await detectTreeVersion(project.tasksDir);
      } catch (err) {
        if (isTaskError(err)) return { kind: "unresolved", cause: err };
        throw err;
      }
      if (version.kind === "v1") {
        return { kind: "unsupported-version", version: 1 };
      }
      if (version.kind === "unsupported") {
        return { kind: "unsupported-version", version: version.version };
      }
      let tree: Tree;
      try {
        tree = await loadTree(project, { config: version.config });
      } catch (err) {
        const code = errnoCode(err);
        if (code === undefined) throw err;
        const cause = TaskError.internal(
          `${project.tasksDir} cannot be read (${code}).`,
          { tasksDir: project.tasksDir, code },
        );
        return { kind: "unresolved", cause };
      }
      const alias = await this.aliasOfKey(key);
      this.trees.set(key, {
        kind: "ok",
        alias,
        local: false,
        writable: alias !== null,
        key,
        project,
        tree,
      });
      return { kind: "ok" };
    });
  }

  /** The first alias whose directory discovers the tree at `key`. */
  private async aliasOfKey(key: string): Promise<string | null> {
    for (const [alias, relPath] of this.configured()) {
      const state = await this.dirState(
        path.resolve(this.current.key, relPath),
      );
      if (state.kind === "tree" && state.key === key) return alias;
    }
    return null;
  }

  /** The first alias configured at exactly `dir`, which holds no tree. */
  private async aliasOfDir(dir: string): Promise<string | null> {
    const target = await canonical(dir);
    for (const [alias, relPath] of this.configured()) {
      const candidate = path.resolve(this.current.key, relPath);
      if ((await canonical(candidate)) === target) return alias;
    }
    return null;
  }

  /** A foreign holder lists `dir` under its own `projects:`. */
  private async holderLists(holder: LoadedTree, dir: string): Promise<boolean> {
    if (holder.key === this.current.key) return false;
    const target = await canonical(dir);
    for (const relPath of Object.values(holder.tree.config.projects)) {
      const candidate = path.resolve(holder.key, relPath);
      if ((await canonical(candidate)) === target) return true;
    }
    return false;
  }

  private configured(): Array<[string, string]> {
    return Object.entries(this.current.tree.config.projects);
  }
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

/** Concurrent callers share one promise, so a tree is never read twice. */
function memo<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = load();
    cache.set(key, hit);
  }
  return hit;
}

/**
 * The identity of a place on disk: its realpath, or for a path that does not
 * exist the realpath of its nearest existing ancestor joined with the rest,
 * so two spellings of one absent directory still compare equal.
 */
async function canonical(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const rest: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The constructor is synchronous; one native realpath call is cheap. */
function realpathOrResolved(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The posix relative path from one project root to another, or `null` when
 * none exists (two drives on Windows) or the roots coincide.
 */
function relativeProjectPath(from: string, to: string): string | null {
  const relative = path.relative(from, to);
  if (relative === "" || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
