import yaml from "js-yaml";
import { z } from "zod";

import { TaskError } from "../errors.js";
import { isIsoTimestamp } from "./time.js";
import type { ExtraKeys, Frontmatter } from "./types.js";
import {
  ACTOR_PATTERN,
  DEFAULT_PRIORITY,
  FRONTMATTER_KEYS,
  PRIORITIES,
  STATUSES,
} from "./types.js";

/* ------------------------------------------------------------------------ */
/* Results                                                                  */
/* ------------------------------------------------------------------------ */

export interface ManifestIssue {
  /** The top-level frontmatter key concerned, or `null` for the structure. */
  field: string | null;
  message: string;
}

export interface ParsedTaskFile {
  frontmatter: Frontmatter;
  /** Keys this revision does not define, in the order read. */
  extra: ExtraKeys;
  /** Leading blank lines and trailing whitespace already normalized. */
  body: string;
}

export type TaskFileParse =
  | ({ ok: true } & ParsedTaskFile)
  | { ok: false; message: string; issues: ManifestIssue[] };

/**
 * A manifest that cannot be read as one. Deliberately not a `TaskError`: a
 * malformed manifest is a finding the scanner collects, not a command failure.
 */
export class MalformedManifestError extends Error {
  readonly issues: ManifestIssue[];

  constructor(issues: ManifestIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "MalformedManifestError";
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------------ */
/* Splitting                                                                */
/* ------------------------------------------------------------------------ */

const DELIMITER = "---";

/** Strips the line terminator so CRLF checkouts split like LF ones. */
function lineAt(text: string, start: number): { line: string; next: number } {
  const end = text.indexOf("\n", start);
  const stop = end === -1 ? text.length : end;
  return {
    line: text.slice(start, stop).replace(/\r$/, ""),
    next: end === -1 ? -1 : end + 1,
  };
}

/**
 * The strict split the convention requires: a first line of exactly `---`, the
 * YAML, and the next line of exactly `---`. Anything looser would let two
 * implementations disagree about where the body starts.
 */
function splitFrontmatter(
  source: string,
): { yaml: string; body: string } | { error: string } {
  // A byte-order mark is an encoding artifact some editors add, not content.
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;

  const first = lineAt(text, 0);
  if (first.line !== DELIMITER) {
    return { error: "the file does not begin with a `---` line" };
  }

  for (let pos = first.next; pos !== -1; ) {
    const current = lineAt(text, pos);
    if (current.line === DELIMITER) {
      return {
        yaml: text.slice(first.next, pos),
        body: current.next === -1 ? "" : text.slice(current.next),
      };
    }
    pos = current.next;
  }
  return { error: "the frontmatter has no closing `---` line" };
}

/* ------------------------------------------------------------------------ */
/* Schema                                                                   */
/* ------------------------------------------------------------------------ */

const ISO_EXAMPLE = "2026-09-21T09:14:00Z";

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return String(value);
}

function expecting(what: string): { errorMap: z.ZodErrorMap } {
  return {
    errorMap: (issue, ctx) => ({
      message:
        issue.code === z.ZodIssueCode.invalid_type &&
        issue.received === z.ZodParsedType.undefined
          ? "is required"
          : `must be ${what}, got ${describe(ctx.data)}`,
    }),
  };
}

function stringMatching(what: string, test: (value: string) => boolean) {
  return z.string(expecting(what)).superRefine((value, ctx) => {
    if (!test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be ${what}, got ${describe(value)}`,
      });
    }
  });
}

const timestamp = stringMatching(
  `an ISO 8601 UTC timestamp such as ${ISO_EXAMPLE}`,
  isIsoTimestamp,
);

const actor = stringMatching(
  `null or an identity matching ${ACTOR_PATTERN.source}`,
  (value) => ACTOR_PATTERN.test(value),
)
  .nullable()
  .default(null);

// Whether each entry parses as a reference is a validation finding, not a
// parse failure: an unparseable reference blocks, it does not hide the task.
const references = z
  .array(
    z
      .string(expecting("a non-empty string"))
      .min(1, "must be a non-empty string"),
    expecting("a list of references such as [auth-rework/token-schema]"),
  )
  .default([]);

const frontmatterSchema = z.object({
  status: z.enum(STATUSES, expecting(`one of ${STATUSES.join(", ")}`)),
  priority: z
    .enum(PRIORITIES, expecting(`one of ${PRIORITIES.join(", ")}`))
    .default(DEFAULT_PRIORITY),
  depends_on: references,
  finishes_after: references,
  assignee: actor,
  claimed_by: actor,
  claimed_at: timestamp.nullable().default(null),
  claimed_session: actor,
  created: timestamp,
  updated: timestamp,
});

const KNOWN_KEYS: ReadonlySet<string> = new Set(FRONTMATTER_KEYS);

function issuePath(path: (string | number)[]): string {
  return path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`,
    )
    .join("");
}

function toIssue(issue: z.ZodIssue): ManifestIssue {
  const head = issue.path[0];
  return {
    field: typeof head === "string" ? head : null,
    message: `${issuePath(issue.path)} ${issue.message}`,
  };
}

/* ------------------------------------------------------------------------ */
/* Parsing                                                                  */
/* ------------------------------------------------------------------------ */

function failure(issues: ManifestIssue[]): TaskFileParse {
  return {
    ok: false,
    message: issues.map((issue) => issue.message).join("; "),
    issues,
  };
}

function describeYamlError(error: unknown): string {
  if (error instanceof yaml.YAMLException) {
    // The YAML starts on the second line of the file, after the `---`.
    const line = error.mark ? ` at line ${error.mark.line + 2}` : "";
    return `the frontmatter is not valid YAML${line}: ${error.reason}`;
  }
  return `the frontmatter is not valid YAML: ${String(error)}`;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Leading blank lines removed, trailing whitespace trimmed, nothing else. */
export function normalizeBody(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
}

export function safeParseTaskFile(source: string): TaskFileParse {
  const split = splitFrontmatter(source);
  if ("error" in split) return failure([{ field: null, message: split.error }]);

  let data: unknown;
  try {
    // JSON_SCHEMA keeps timestamp-shaped scalars as strings instead of Dates.
    data = yaml.load(split.yaml, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    return failure([{ field: null, message: describeYamlError(error) }]);
  }
  if (!isMapping(data)) {
    return failure([
      { field: null, message: "the frontmatter is not a YAML mapping" },
    ]);
  }

  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) return failure(parsed.error.issues.map(toIssue));

  const fields = parsed.data;
  const frontmatter: Frontmatter = {
    status: fields.status,
    priority: fields.priority,
    depends_on: fields.depends_on,
    finishes_after: fields.finishes_after,
    assignee: fields.assignee,
    claimed_by: fields.claimed_by,
    claimed_at: fields.claimed_at,
    claimed_session: fields.claimed_session,
    created: fields.created,
    updated: fields.updated,
  };
  // Read order is the order js-yaml inserted the keys, except that a
  // JavaScript object lists integer-like keys first; such keys are rare
  // enough in frontmatter that their position is not worth a parser of our own.
  const extra: ExtraKeys = Object.entries(data).filter(
    ([key]) => !KNOWN_KEYS.has(key),
  );

  return { ok: true, frontmatter, extra, body: normalizeBody(split.body) };
}

export function parseTaskFile(source: string): ParsedTaskFile {
  const result = safeParseTaskFile(source);
  if (!result.ok) throw new MalformedManifestError(result.issues);
  return result;
}

/* ------------------------------------------------------------------------ */
/* Canonical serialization                                                  */
/* ------------------------------------------------------------------------ */

/** Characters that can stay plain anywhere, including inside `[a, b]`. */
const PLAIN_SAFE = /^[A-Za-z0-9._/][A-Za-z0-9._/@+-]*$/;

/** Plain words a YAML 1.1 reader takes for booleans. */
const YAML11_BOOLEANS =
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

/** Characters JSON leaves raw that YAML does not accept or may misread. */
const YAML_UNSAFE_RAW = /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g;

function readsBackAsString(value: string): boolean {
  if (YAML11_BOOLEANS.test(value)) return false;
  try {
    // The richest schema decides, so no reader mistakes the scalar for a
    // number, a boolean, null or a timestamp.
    return yaml.load(value, { schema: yaml.DEFAULT_SCHEMA }) === value;
  } catch {
    return false;
  }
}

function doubleQuoted(value: string): string {
  return JSON.stringify(value).replace(
    YAML_UNSAFE_RAW,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * A string scalar, unquoted when it is unambiguous plain YAML and quoted
 * otherwise. Shared with `config.yml` so both files quote alike.
 */
export function yamlScalar(value: string): string {
  return PLAIN_SAFE.test(value) && readsBackAsString(value)
    ? value
    : doubleQuoted(value);
}

function flowList(values: readonly string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

function nullable(value: string | null): string {
  return value === null ? "null" : yamlScalar(value);
}

function quotedTimestamp(value: string | null): string {
  return value === null ? "null" : doubleQuoted(value);
}

/**
 * Re-emit an unknown key's value unchanged. Collections nested in it stay on
 * one line in flow style, like the defined lists; the default schema quotes
 * any string another YAML reader could take for something else.
 */
function dumpExtra(key: string, value: unknown): string {
  return yaml
    .dump(
      { [key]: value },
      {
        schema: yaml.DEFAULT_SCHEMA,
        flowLevel: 1,
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
      },
    )
    .replace(/\n$/, "");
}

/** The frontmatter block between the delimiters, without a final newline. */
export function serializeFrontmatter(
  frontmatter: Frontmatter,
  extra: ExtraKeys = [],
): string {
  const lines = [
    `status: ${yamlScalar(frontmatter.status)}`,
    `priority: ${yamlScalar(frontmatter.priority)}`,
    `depends_on: ${flowList(frontmatter.depends_on)}`,
    `finishes_after: ${flowList(frontmatter.finishes_after)}`,
    `assignee: ${nullable(frontmatter.assignee)}`,
    `claimed_by: ${nullable(frontmatter.claimed_by)}`,
    `claimed_at: ${quotedTimestamp(frontmatter.claimed_at)}`,
    `claimed_session: ${nullable(frontmatter.claimed_session)}`,
    `created: ${quotedTimestamp(frontmatter.created)}`,
    `updated: ${quotedTimestamp(frontmatter.updated)}`,
  ];
  for (const [key, value] of extra) {
    // An extra key can never shadow a defined field, and an absent value has
    // no YAML spelling.
    if (KNOWN_KEYS.has(key) || value === undefined) continue;
    lines.push(dumpExtra(key, value));
  }
  return lines.join("\n");
}

/**
 * The whole manifest in canonical form. Refuses, as an internal error, to
 * produce a file that would not read back to the same state: a write must
 * never turn a task malformed or make the next write differ.
 */
export function renderTaskFile(
  frontmatter: Frontmatter,
  extra: ExtraKeys,
  body: string,
): string {
  const checked = frontmatterSchema.safeParse(frontmatter);
  if (!checked.success) {
    throw TaskError.internal(
      `Refusing to write an invalid manifest: ${checked.error.issues
        .map((issue) => toIssue(issue).message)
        .join("; ")}.`,
    );
  }

  const block = serializeFrontmatter(frontmatter, extra);
  const normalized = normalizeBody(body);
  const text =
    normalized.length > 0
      ? `---\n${block}\n---\n\n${normalized}\n`
      : `---\n${block}\n---\n`;

  const back = safeParseTaskFile(text);
  if (
    !back.ok ||
    serializeFrontmatter(back.frontmatter, back.extra) !== block ||
    back.body !== normalized
  ) {
    throw TaskError.internal(
      "Refusing to write a manifest that does not read back unchanged.",
      back.ok ? undefined : { message: back.message },
    );
  }
  return text;
}
