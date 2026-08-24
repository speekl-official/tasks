import grayMatter from "gray-matter";
import yaml from "js-yaml";
import { z } from "zod";

import { TaskError } from "../errors.js";

/**
 * The machine-owned portion of a task file. Key order here is the canonical
 * serialization order — every CLI write emits exactly this shape so diffs stay
 * minimal and reviewable across machines.
 */
export interface Frontmatter {
  id: string;
  phase: string;
  status: string;
  depends_on: string[];
  created: string;
  updated: string;
  claimed_by: string | null;
  claimed_at: string | null;
}

export const frontmatterSchema = z
  .object({
    id: z.string().min(1),
    phase: z.string().min(1),
    status: z.string().min(1),
    depends_on: z.array(z.string().min(1)).default([]),
    created: z.string().min(1),
    updated: z.string().min(1),
    claimed_by: z.string().min(1).nullable().default(null),
    claimed_at: z.string().min(1).nullable().default(null),
  })
  .passthrough();

/**
 * gray-matter handles the ---/--- split; we supply the YAML engine so parsing
 * uses JSON_SCHEMA (no Date coercion) and serialization stays canonical.
 */
const engine = {
  parse: (source: string): object =>
    (yaml.load(source, { schema: yaml.JSON_SCHEMA }) as object | null | undefined) ?? {},
  stringify: (): string => {
    throw TaskError.internal("Frontmatter serialization must go through serializeFrontmatter().");
  },
};

/** Plain YAML scalars that need no quoting: slugs, statuses, simple refs. */
const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function yamlString(value: string, { forceQuotes = false } = {}): string {
  if (!forceQuotes && PLAIN_SCALAR.test(value)) return value;
  // YAML double-quoted scalars follow JSON escaping rules closely enough that
  // JSON.stringify produces valid, unambiguous output for any UTF-8 string.
  return JSON.stringify(value);
}

function yamlList(values: string[]): string {
  if (values.length === 0) return "[]";
  return `[${values.map((v) => yamlString(v)).join(", ")}]`;
}

function yamlNullable(value: string | null, opts?: { forceQuotes?: boolean }): string {
  return value === null ? "null" : yamlString(value, opts);
}

/**
 * Emit frontmatter in canonical form. Dates are always quoted so they round-trip
 * as strings rather than being re-read as YAML timestamps.
 *
 * Known, documented consequence: comments inside the frontmatter block are not
 * preserved. The block is machine-owned; comments belong in the body.
 */
export function serializeFrontmatter(fm: Frontmatter): string {
  const lines = [
    `id: ${yamlString(fm.id)}`,
    `phase: ${yamlString(fm.phase)}`,
    `status: ${yamlString(fm.status)}`,
    `depends_on: ${yamlList(fm.depends_on)}`,
    `created: ${yamlString(fm.created, { forceQuotes: true })}`,
    `updated: ${yamlString(fm.updated, { forceQuotes: true })}`,
    `claimed_by: ${yamlNullable(fm.claimed_by)}`,
    `claimed_at: ${yamlNullable(fm.claimed_at, { forceQuotes: true })}`,
  ];
  return lines.join("\n");
}

export function renderTaskFile(fm: Frontmatter, body: string): string {
  const normalizedBody = body.replace(/^\n+/, "").replace(/\s*$/, "");
  return `---\n${serializeFrontmatter(fm)}\n---\n\n${normalizedBody}\n`;
}

export interface ParsedTaskFile {
  data: Record<string, unknown>;
  body: string;
}

export function splitTaskFile(source: string): ParsedTaskFile {
  const parsed = grayMatter(source, { engines: { yaml: engine } });
  return { data: parsed.data as Record<string, unknown>, body: parsed.content };
}
