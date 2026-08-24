export interface Task {
  /** Authoritative identity, from frontmatter. */
  id: string;
  /** Authoritative phase: the containing directory name. */
  phase: string;
  status: string;
  depends_on: string[];
  created: string;
  updated: string;
  claimed_by: string | null;
  claimed_at: string | null;

  body: string;
  filePath: string;
  archived: boolean;

  /** Frontmatter's own `phase`, retained so `validate` can report drift. */
  frontmatterPhase: string;
  /** Filename stem, retained so `validate` can report id/filename mismatch. */
  filenameId: string;
}

/** Second-precision UTC — enough for claim diagnostics, stable in diffs. */
export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

export function taskTitle(task: Task): string {
  const heading = task.body.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() ?? task.id;
}
