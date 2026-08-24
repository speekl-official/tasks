import { TaskError } from "../errors.js";

/**
 * Derive a task id from a free-form name. Lowercase kebab-case, ASCII-folded
 * where possible so ids stay filesystem- and URL-safe.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (slug.length === 0) {
    throw TaskError.usage(
      `Cannot derive a task id from "${name}". Pass an explicit id with --id.`,
      { name },
    );
  }
  return slug;
}

const PHASE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function assertValidPhase(phase: string): void {
  if (!PHASE_PATTERN.test(phase)) {
    throw TaskError.usage(
      `Invalid phase "${phase}". Phases are lowercase slugs (letters, digits, dots, hyphens, underscores).`,
      { phase },
    );
  }
}
