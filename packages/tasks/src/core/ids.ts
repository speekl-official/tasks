import path from "node:path";

import { TaskError } from "../errors.js";
import type { AmbiguousDetails } from "./types.js";
import { SEGMENT_PATTERN } from "./types.js";

/**
 * Identity is structural: a task's id is its path relative to `.tasks/` (or
 * to `.archive/` for an archived task), segments joined by `/` on every
 * platform. This module is the only place that converts between ids and
 * native filesystem paths, so the rest of the code never sees a separator.
 */

export function isSegment(value: string): boolean {
  return SEGMENT_PATTERN.test(value);
}

/** A non-empty `/`-joined sequence of segments: a task id or a group path. */
export function isTaskPath(value: string): boolean {
  return value.length > 0 && value.split("/").every(isSegment);
}

/** Throws a usage error naming `label` when `value` is not a task path. */
export function assertTaskPath(value: string, label = "path"): string {
  if (!isTaskPath(value)) {
    throw TaskError.usage(
      `Invalid ${label} "${value}": expected segments matching ${SEGMENT_PATTERN.source} joined by "/".`,
      { [label]: value },
    );
  }
  return value;
}

export function segmentsOf(id: string): string[] {
  return id.split("/");
}

/** The parent path, or `null` for a top-level id. Not the parent task. */
export function parentOf(id: string): string | null {
  const cut = id.lastIndexOf("/");
  return cut === -1 ? null : id.slice(0, cut);
}

/** The last segment. */
export function nameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

export function depthOf(id: string): number {
  return segmentsOf(id).length;
}

/** True when `id` is `ancestorId` itself or lies beneath it. */
export function isWithin(id: string, ancestorId: string): boolean {
  return id === ancestorId || id.startsWith(`${ancestorId}/`);
}

/** True when `id` lies strictly beneath `ancestorId`. */
export function isBelow(id: string, ancestorId: string): boolean {
  return id.startsWith(`${ancestorId}/`);
}

/** Every proper prefix path of `id`, nearest first: `a/b/c` → `a/b`, `a`. */
export function ancestorPaths(id: string): string[] {
  const out: string[] = [];
  for (let p = parentOf(id); p !== null; p = parentOf(p)) out.push(p);
  return out;
}

/**
 * Orders ids segment by segment, so a listing reads in tree order: a parent
 * comes right before its subtree (`a`, `a/b`, `a-b`), which plain string
 * order would interleave (`a`, `a-b`, `a/b`). Code-unit order within a
 * segment keeps it independent of the locale.
 */
export function compareIds(a: string, b: string): number {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left[i]!;
    const y = right[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/** The native path of `id` under `baseDir` (`.tasks/` or `.tasks/.archive/`). */
export function idToNative(baseDir: string, id: string): string {
  return path.join(baseDir, ...segmentsOf(id));
}

/**
 * The id of the native path `target` under `baseDir`, or `null` when the path
 * is not strictly inside `baseDir` or is not made of valid segments.
 */
export function nativeToId(baseDir: string, target: string): string | null {
  const relative = path.relative(path.resolve(baseDir), path.resolve(target));
  if (relative === "" || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  if (segments[0] === "..") return null;
  const id = segments.join("/");
  return isTaskPath(id) ? id : null;
}

/** `alias:id` for a task in a listed project, the bare id for the local tree. */
export function qualifyId(project: string | null, id: string): string {
  return project === null ? id : `${project}:${id}`;
}

/* ------------------------------------------------------------------------ */
/* Reference grammar                                                        */
/* ------------------------------------------------------------------------ */

export interface LocalReference {
  kind: "local";
  path: string;
}

export interface ExternalReference {
  kind: "external";
  /** Relative to the project root of the tree that stores the reference. */
  projectPath: string;
  path: string;
}

export type Reference = LocalReference | ExternalReference;

export type ReferenceParse =
  | { ok: true; ref: Reference }
  | { ok: false; message: string };

/**
 * True for a path that only resolves on one machine: posix or Windows
 * absolute, UNC, or drive-letter (including drive-relative `C:x`). Committed
 * references must resolve in every clone.
 */
export function isMachineBoundPath(value: string): boolean {
  return (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  );
}

/**
 * Parse a stored reference: split on the last `:`; without a colon the whole
 * string is a local path. Segments cannot contain a colon, which is what makes
 * the split unambiguous even when the project path contains one.
 */
export function safeParseReference(raw: string): ReferenceParse {
  if (raw.length === 0) return { ok: false, message: "reference is empty" };

  const cut = raw.lastIndexOf(":");
  const refPath = cut === -1 ? raw : raw.slice(cut + 1);
  if (!isTaskPath(refPath)) {
    return {
      ok: false,
      message: `"${refPath}" is not a task path (segments matching ${SEGMENT_PATTERN.source} joined by "/")`,
    };
  }
  if (cut === -1) return { ok: true, ref: { kind: "local", path: refPath } };

  const projectPath = raw.slice(0, cut);
  if (projectPath.length === 0) {
    return { ok: false, message: "the project path before the colon is empty" };
  }
  if (isMachineBoundPath(projectPath)) {
    return {
      ok: false,
      message: `project path "${projectPath}" is absolute; use a path relative to the project root`,
    };
  }
  return { ok: true, ref: { kind: "external", projectPath, path: refPath } };
}

export function parseReference(raw: string): Reference {
  const result = safeParseReference(raw);
  if (!result.ok) {
    throw TaskError.usage(`Invalid reference "${raw}": ${result.message}.`, {
      ref: raw,
    });
  }
  return result.ref;
}

export function formatReference(ref: Reference): string {
  return ref.kind === "local" ? ref.path : `${ref.projectPath}:${ref.path}`;
}

/* ------------------------------------------------------------------------ */
/* Command-line addressing                                                  */
/* ------------------------------------------------------------------------ */

export interface TaskArgument {
  /** The part before the last colon (an alias or a project path), or `null`. */
  prefix: string | null;
  /** A full id or a suffix of one. */
  path: string;
}

/**
 * Split a task argument the way references split. Whether the prefix names a
 * configured alias or a project path is for the caller to decide.
 */
export function splitTaskArgument(arg: string): TaskArgument {
  const ref = parseReference(arg);
  return ref.kind === "local"
    ? { prefix: null, path: ref.path }
    : { prefix: ref.projectPath, path: ref.path };
}

export interface ResolveSuffixOptions {
  /** The argument as the user typed it, for the message and `details`. */
  argument?: string;
  /** Turns a candidate id into the form shown to the user (e.g. qualified). */
  qualify?: (id: string) => string;
}

/**
 * Resolve a command-line path against the given ids: an exact id wins;
 * otherwise the single id ending with `/<arg>`. Several candidates are a usage
 * error naming them; none is not-found.
 */
export function resolveSuffix(
  arg: string,
  ids: Iterable<string>,
  options: ResolveSuffixOptions = {},
): string {
  const argument = options.argument ?? arg;
  const show = options.qualify ?? ((id: string) => id);
  assertTaskPath(arg, "task");

  const candidates: string[] = [];
  for (const id of ids) {
    if (id === arg) return id;
    if (id.endsWith(`/${arg}`)) candidates.push(id);
  }

  if (candidates.length === 1) return candidates[0]!;

  if (candidates.length > 1) {
    const shown = candidates.sort(compareIds).map(show);
    const details: AmbiguousDetails = { argument, candidates: shown };
    throw TaskError.usage(
      `"${argument}" is ambiguous: it matches ${shown.join(", ")}. Use a longer suffix or the full path.`,
      { ...details },
    );
  }

  throw TaskError.notFound(`No task matches "${argument}".`, { argument });
}
