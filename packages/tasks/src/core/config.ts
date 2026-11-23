import fs from "node:fs/promises";
import path from "node:path";

import yaml from "js-yaml";

import { TaskError } from "../errors.js";
import { findProject } from "./discovery.js";
import { yamlScalar } from "./frontmatter.js";
import { errnoCode, isDirectory } from "./fs-utils.js";
import { isMachineBoundPath, isTaskPath } from "./ids.js";
import type { ActorEntry, ActorType } from "./types.js";
import {
  ACTOR_PATTERN,
  ACTOR_TYPES,
  AGENT_ACTOR,
  CONFIG_FILENAME,
  CONVENTION_VERSION,
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  FRONTMATTER_KEYS,
  SEGMENT_PATTERN,
} from "./types.js";

export interface Config {
  version: 2;
  /** Default query scope, a group or task path; never limits addressing. */
  scope: string | null;
  sessionTimeoutMinutes: number;
  /** Days after which a resolved task is expected to be archived; `null` unset. */
  archiveResolvedAfterDays: number | null;
  /**
   * Actor → its type and one-line description, in configured order: the
   * roster of who tasks may be assigned to. Has no prototype.
   */
  actors: Record<string, ActorEntry>;
  /**
   * Name → path relative to the project root, a directory or a file, inside
   * the repository or beside it: where the project's documentation lives,
   * which an agent brings up to date before `done`. Has no prototype.
   */
  docs: Record<string, string>;
  /**
   * The frontmatter keys of the project's own that its manifests may carry
   * beside the ten the convention defines, in configured order. Empty when
   * none is declared: an undefined key is then a validation warning; once any
   * is declared, a key outside the list is an error and a listed one is not
   * reported.
   */
  customFields: string[];
  /** Alias → path relative to the project root. Has no prototype. */
  projects: Record<string, string>;
}

/** What `loadConfig` returns for a v1 tree when the caller allows one. */
export interface V1Config {
  version: 1;
}

export type TreeVersion =
  | { kind: "v2"; config: Config }
  | { kind: "v1" }
  | { kind: "unsupported"; version: number };

export interface LoadConfigOptions {
  /** Return `{ version: 1 }` for a v1 tree instead of refusing it. */
  allowV1?: boolean;
}

export const CONFIG_KEYS = [
  "version",
  "scope",
  "session_timeout_minutes",
  "archive_resolved_after_days",
  "actors",
  "docs",
  "custom_fields",
  "projects",
] as const;

/** A project's own frontmatter key: a plain YAML key, as `task.md` holds it. */
const CUSTOM_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const V1_KEY_HINTS: Record<string, string> = {
  active_phase: "; v2 calls it `scope`",
  statuses: "; the v2 lifecycle is fixed",
  roles: "; the v2 lifecycle is fixed",
  transitions: "; the v2 lifecycle is fixed",
};

export function defaultConfig(): Config {
  return {
    version: CONVENTION_VERSION,
    scope: null,
    sessionTimeoutMinutes: DEFAULT_SESSION_TIMEOUT_MINUTES,
    archiveResolvedAfterDays: null,
    actors: Object.create(null) as Record<string, ActorEntry>,
    docs: Object.create(null) as Record<string, string>,
    customFields: [],
    projects: Object.create(null) as Record<string, string>,
  };
}

/** The configured path of `alias`, without reaching into the prototype. */
export function projectPathOf(
  config: Config,
  alias: string,
): string | undefined {
  return Object.hasOwn(config.projects, alias)
    ? config.projects[alias]
    : undefined;
}

/* ------------------------------------------------------------------------ */
/* Parsing                                                                  */
/* ------------------------------------------------------------------------ */

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return String(value);
}

function invalid(file: string, message: string, key?: string): TaskError {
  return TaskError.usage(`${file}: ${message}`, {
    file,
    ...(key === undefined ? {} : { key }),
  });
}

/**
 * One `name: path` entry of `docs` or `projects`: the name a segment, the
 * path relative to the project root, so it resolves in every clone.
 */
function relativeEntry(
  file: string,
  key: "docs" | "projects",
  nameNoun: string,
  noun: string,
  name: string,
  target: unknown,
): string {
  if (!SEGMENT_PATTERN.test(name)) {
    throw invalid(
      file,
      `${nameNoun} "${name}" must match ${SEGMENT_PATTERN.source}.`,
      key,
    );
  }
  if (typeof target !== "string" || target.length === 0) {
    throw invalid(
      file,
      `${noun} "${name}" must map to a relative path, got ${describe(target)}.`,
      key,
    );
  }
  if (isMachineBoundPath(target)) {
    throw invalid(
      file,
      `${noun} "${name}" maps to the absolute path "${target}"; use a path relative to the project root, so it resolves in every clone.`,
      key,
    );
  }
  return target;
}

/**
 * The `actors:` keys as written, before YAML typing: `007` or `True` reads
 * as a number or a boolean under the JSON schema and comes back as `7` or
 * `true`, a name nobody typed. Compared against the typed keys so such a
 * name is refused rather than silently changed.
 */
function rawActorKeys(source: string): string[] {
  try {
    const raw = yaml.load(source, { schema: yaml.FAILSAFE_SCHEMA });
    if (!isMapping(raw) || !isMapping(raw.actors)) return [];
    return Object.keys(raw.actors);
  } catch {
    return [];
  }
}

/** `person`, unless the name is the agent's by convention. */
export function defaultActorType(actor: string): ActorType {
  return actor === AGENT_ACTOR ? "agent" : "person";
}

function isActorType(value: unknown): value is ActorType {
  return typeof value === "string" && ACTOR_TYPES.includes(value as ActorType);
}

/** A one-line description, trimmed; `null` for nothing. */
function actorDescription(
  file: string,
  actor: string,
  value: unknown,
): string | null {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw invalid(
      file,
      `actor "${actor}" must carry a one-line description or nothing, got ${describe(value)}.`,
      "actors",
    );
  }
  const line = value?.trim() ?? "";
  if (/[\r\n]/.test(line)) {
    throw invalid(
      file,
      `actor "${actor}" must carry a one-line description, got several lines.`,
      "actors",
    );
  }
  return line === "" ? null : line;
}

/**
 * The value of an `actors:` entry: a description or nothing (the common
 * form, a person unless the name is `agent`), or a mapping with `type` and
 * `description` for an agent under another name.
 */
function actorEntry(file: string, actor: string, value: unknown): ActorEntry {
  if (!isMapping(value)) {
    return {
      type: defaultActorType(actor),
      description: actorDescription(file, actor, value),
    };
  }
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "description") {
      throw invalid(
        file,
        `actor "${actor}" has an unknown key "${key}"; an actor carries type and description.`,
        "actors",
      );
    }
  }
  const type = value.type ?? defaultActorType(actor);
  if (!isActorType(type)) {
    throw invalid(
      file,
      `actor "${actor}" has type ${describe(value.type)}; expected ${ACTOR_TYPES.join(" or ")}.`,
      "actors",
    );
  }
  return {
    type,
    description: actorDescription(file, actor, value.description),
  };
}

function parseV2(
  doc: Record<string, unknown>,
  file: string,
  rawActors: readonly string[],
): Config {
  for (const key of Object.keys(doc)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw invalid(
        file,
        `unknown key "${key}"${V1_KEY_HINTS[key] ?? ""}. The keys of a v2 config.yml are ${CONFIG_KEYS.join(", ")}.`,
        key,
      );
    }
  }

  const config = defaultConfig();

  // An optional key set to null reads as absent: `projects:` with every alias
  // commented out is an ordinary editing state, not an error.
  const scope = doc.scope;
  if (scope !== undefined && scope !== null) {
    if (typeof scope !== "string" || !isTaskPath(scope)) {
      throw invalid(
        file,
        `scope must be a group or task path such as auth-rework, got ${describe(scope)}.`,
        "scope",
      );
    }
    config.scope = scope;
  }

  const timeout = doc.session_timeout_minutes;
  if (timeout !== undefined && timeout !== null) {
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < 1
    ) {
      throw invalid(
        file,
        `session_timeout_minutes must be an integer of at least 1, got ${describe(timeout)}.`,
        "session_timeout_minutes",
      );
    }
    config.sessionTimeoutMinutes = timeout;
  }

  const archiveAfter = doc.archive_resolved_after_days;
  if (archiveAfter !== undefined && archiveAfter !== null) {
    if (
      typeof archiveAfter !== "number" ||
      !Number.isInteger(archiveAfter) ||
      archiveAfter < 1
    ) {
      throw invalid(
        file,
        `archive_resolved_after_days must be an integer of at least 1, got ${describe(archiveAfter)}.`,
        "archive_resolved_after_days",
      );
    }
    config.archiveResolvedAfterDays = archiveAfter;
  }

  const actors = doc.actors;
  if (actors !== undefined && actors !== null) {
    if (!isMapping(actors)) {
      throw invalid(
        file,
        `actors must be a mapping of actor to a one-line description (alice: maintainer), got ${describe(actors)}.`,
        "actors",
      );
    }
    for (const [actor, value] of Object.entries(actors)) {
      if (!ACTOR_PATTERN.test(actor)) {
        throw invalid(
          file,
          `actor "${actor}" must match ${ACTOR_PATTERN.source} (letters, digits and . _ @ + -, no spaces).`,
          "actors",
        );
      }
      config.actors[actor] = actorEntry(file, actor, value);
    }
    for (const raw of rawActors) {
      if (!Object.hasOwn(config.actors, raw)) {
        throw invalid(
          file,
          `actor "${raw}" is read by YAML as a number, a boolean or null, not as a name; quote it ("${raw}").`,
          "actors",
        );
      }
    }
  }

  const docs = doc.docs;
  if (docs !== undefined && docs !== null) {
    if (!isMapping(docs)) {
      throw invalid(
        file,
        `docs must be a mapping of name to relative path (engineering: docs/engineering), got ${describe(docs)}.`,
        "docs",
      );
    }
    for (const [name, target] of Object.entries(docs)) {
      config.docs[name] = relativeEntry(
        file,
        "docs",
        "docs name",
        "docs location",
        name,
        target,
      );
    }
  }

  const customFields = doc.custom_fields;
  if (customFields !== undefined && customFields !== null) {
    if (!Array.isArray(customFields)) {
      throw invalid(
        file,
        `custom_fields must be a list of the project's own frontmatter key names ([review_ticket, estimate_days]), got ${describe(customFields)}.`,
        "custom_fields",
      );
    }
    for (const name of customFields) {
      if (typeof name !== "string" || !CUSTOM_FIELD_PATTERN.test(name)) {
        throw invalid(
          file,
          `custom_fields entry ${describe(name)} is not a key name: letters, digits, _ and -, starting with a letter or _.`,
          "custom_fields",
        );
      }
      if ((FRONTMATTER_KEYS as readonly string[]).includes(name)) {
        throw invalid(
          file,
          `custom_fields names "${name}", a field the convention defines; list only the project's own keys.`,
          "custom_fields",
        );
      }
      if (config.customFields.includes(name)) {
        throw invalid(
          file,
          `custom_fields lists "${name}" twice.`,
          "custom_fields",
        );
      }
      config.customFields.push(name);
    }
  }

  const projects = doc.projects;
  if (projects !== undefined && projects !== null) {
    if (!isMapping(projects)) {
      throw invalid(
        file,
        `projects must be a mapping of alias to relative path, got ${describe(projects)}.`,
        "projects",
      );
    }
    for (const [alias, target] of Object.entries(projects)) {
      config.projects[alias] = relativeEntry(
        file,
        "projects",
        "project alias",
        "project",
        alias,
        target,
      );
    }
  }

  return config;
}

/**
 * Classify and parse a `config.yml` source without touching the disk. A
 * missing `version` (or an empty document, which v1 allowed) is a v1 tree.
 */
export function parseConfigText(source: string, file: string): TreeVersion {
  let doc: unknown;
  try {
    doc = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const reason = err instanceof yaml.YAMLException ? err.reason : String(err);
    throw invalid(file, `invalid YAML: ${reason}.`);
  }

  if (doc === undefined || doc === null) return { kind: "v1" };
  if (!isMapping(doc)) {
    throw invalid(file, `expected a mapping of keys, got ${describe(doc)}.`);
  }
  if (!Object.hasOwn(doc, "version")) return { kind: "v1" };

  const version = doc.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw invalid(
      file,
      `version must be the integer ${CONVENTION_VERSION}, got ${describe(version)}.`,
      "version",
    );
  }
  if (version === 1) return { kind: "v1" };
  if (version !== CONVENTION_VERSION) return { kind: "unsupported", version };
  return { kind: "v2", config: parseV2(doc, file, rawActorKeys(source)) };
}

async function realOrResolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Reject an alias that leads back to this tree: through discovery, a path
 * inside this project without a `.tasks/` of its own resolves here too. A
 * path that is not checked out cannot be judged and is left to the projects
 * layer as not checked out.
 */
async function rejectSelfAliases(
  config: Config,
  root: string,
  file: string,
): Promise<void> {
  const aliases = Object.entries(config.projects);
  if (aliases.length === 0) return;

  const self = await realOrResolved(root);
  for (const [alias, target] of aliases) {
    const resolved = path.resolve(root, target);
    if (!(await isDirectory(resolved))) continue;
    const found = await findProject(resolved);
    if (found && (await realOrResolved(found.root)) === self) {
      throw TaskError.usage(
        `${file}: project "${alias}" (${target}) resolves to this tree itself; an alias must name another tree.`,
        { file, key: "projects", alias, path: target },
      );
    }
  }
}

/** Which convention version the tree at `tasksDir` declares. */
export async function detectTreeVersion(
  tasksDir: string,
): Promise<TreeVersion> {
  const file = path.join(tasksDir, CONFIG_FILENAME);
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT") return { kind: "v1" };
    throw invalid(file, `cannot be read (${code ?? String(err)}).`);
  }

  const detected = parseConfigText(source, file);
  if (detected.kind === "v2") {
    await rejectSelfAliases(detected.config, path.dirname(tasksDir), file);
  }
  return detected;
}

/**
 * The tree's v2 configuration. A v1 tree is refused with the upgrade named,
 * unless the caller (`migrate`) allows it; an unsupported version is refused
 * outright.
 */
export async function loadConfig(tasksDir: string): Promise<Config>;
export async function loadConfig(
  tasksDir: string,
  options: { allowV1: true },
): Promise<Config | V1Config>;
export async function loadConfig(
  tasksDir: string,
  options?: LoadConfigOptions,
): Promise<Config | V1Config>;
export async function loadConfig(
  tasksDir: string,
  options: LoadConfigOptions = {},
): Promise<Config | V1Config> {
  const detected = await detectTreeVersion(tasksDir);
  switch (detected.kind) {
    case "v2":
      return detected.config;
    case "v1":
      if (options.allowV1) return { version: 1 };
      throw TaskError.usage(
        `${tasksDir} is a .tasks v1 tree (no \`version: ${CONVENTION_VERSION}\` in config.yml). Run \`tasks migrate\` to upgrade it.`,
        { tasksDir, version: 1, upgrade: "tasks migrate" },
      );
    case "unsupported":
      throw TaskError.usage(
        `${path.join(tasksDir, CONFIG_FILENAME)}: version ${detected.version} is not supported; this tasks implements .tasks convention version ${CONVENTION_VERSION}.`,
        {
          file: path.join(tasksDir, CONFIG_FILENAME),
          version: detected.version,
          supported: CONVENTION_VERSION,
        },
      );
  }
}

/* ------------------------------------------------------------------------ */
/* Serialization                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Canonical `config.yml`: `version` first, then only the keys that differ
 * from their defaults, actors, docs and aliases in their configured order.
 */
export function renderConfig(config: Config): string {
  const lines = [`version: ${CONVENTION_VERSION}`];
  if (config.scope !== null) lines.push(`scope: ${yamlScalar(config.scope)}`);
  if (config.sessionTimeoutMinutes !== DEFAULT_SESSION_TIMEOUT_MINUTES) {
    lines.push(`session_timeout_minutes: ${config.sessionTimeoutMinutes}`);
  }
  if (config.archiveResolvedAfterDays !== null) {
    lines.push(
      `archive_resolved_after_days: ${config.archiveResolvedAfterDays}`,
    );
  }
  const actors = Object.entries(config.actors);
  if (actors.length > 0) {
    lines.push("actors:");
    for (const [actor, entry] of actors) {
      const description =
        entry.description === null ? null : yamlScalar(entry.description);
      if (entry.type === defaultActorType(actor)) {
        // The common form: the type goes without saying.
        lines.push(
          description === null
            ? `  ${yamlScalar(actor)}:`
            : `  ${yamlScalar(actor)}: ${description}`,
        );
      } else {
        lines.push(`  ${yamlScalar(actor)}:`, `    type: ${entry.type}`);
        if (description !== null) lines.push(`    description: ${description}`);
      }
    }
  }
  const docs = Object.entries(config.docs);
  if (docs.length > 0) {
    lines.push("docs:");
    for (const [name, target] of docs) {
      lines.push(`  ${yamlScalar(name)}: ${yamlScalar(target)}`);
    }
  }
  if (config.customFields.length > 0) {
    lines.push(
      `custom_fields: [${config.customFields.map(yamlScalar).join(", ")}]`,
    );
  }
  const aliases = Object.entries(config.projects);
  if (aliases.length > 0) {
    lines.push("projects:");
    for (const [alias, target] of aliases) {
      lines.push(`  ${yamlScalar(alias)}: ${yamlScalar(target)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
