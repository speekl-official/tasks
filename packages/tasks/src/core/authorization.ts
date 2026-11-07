import { TaskError } from "../errors.js";
import type { Task } from "./task.js";
import type {
  AuthorizationDetails,
  ClaimLiveness,
  Frontmatter,
  Identity,
  Liveness,
} from "./types.js";

/**
 * The authorization rules every write obeys, transitions and the writes
 * that are not (`state`, dependency edits, `delete`, `move`) alike, in one
 * place so the two cannot drift. A claim that is live or unknown admits only
 * its claimant — the same actor and, when the claim has a session, the same
 * session — which is the fence that stops a session superseded by a takeover
 * from writing over the new claimant's work. An orphaned claim protects
 * nothing: the assignee rule decides, and the write records the claim it
 * went past. An assigned task admits its assignee and the assignees of its
 * ancestors; anything else admits anyone. `claim` is the exception: another
 * claim is someone else's work to take over, whoever the actor is.
 */

/** A claim a write went past: an orphaned one, or one `--force` overrode. */
export interface SupersededClaim {
  /** The task that carried it, as output names it. */
  id: string;
  claimant: string;
  session: string | null;
  liveness: Liveness;
  /** The claimant session's last heartbeat, or `null` when none is known. */
  last_seen: string | null;
}

export interface AuthorizationFacts {
  /** The task as re-read inside the lock. */
  task: Task;
  /** Its ancestors, for the assignee rule. */
  ancestors: readonly Task[];
  identity: Identity;
  /** The liveness of its claim, or `null` when the caller sees no claim. */
  claimed: ClaimLiveness | null;
  /** The id as output and error details name it. */
  shown: string;
  /** The command, for messages: `claim`, `pause`, `edit`, `delete`, `move`. */
  command: string;
}

/**
 * Admitted, with the claim the write goes past; or refused, with the
 * refusal `--force` lifts and the claim a forced write then records.
 */
export type Verdict =
  | { admitted: true; superseded: SupersededClaim | null }
  | { admitted: false; refusal: TaskError; superseded: SupersededClaim | null };

/** The claim's own actor, from its own session when it has one. */
export function isClaimant(fm: Frontmatter, identity: Identity): boolean {
  return (
    fm.claimed_by === identity.actor &&
    (fm.claimed_session === null || fm.claimed_session === identity.session)
  );
}

export function judgeAuthorization(facts: AuthorizationFacts): Verdict {
  const { task, identity, claimed, command } = facts;
  if (claimed === null) return assigneeVerdict(facts, null);
  // A claim by the same session was refused before this (`already-claimed`);
  // any other claim is someone else's work to `claim`, whoever the actor is.
  if (command !== "claim" && isClaimant(task.frontmatter, identity)) {
    return { admitted: true, superseded: null };
  }
  const superseded = supersededClaimOf(facts.shown, task.frontmatter, claimed);
  if (claimed.liveness !== "orphaned") {
    return {
      admitted: false,
      refusal: claimantRefusal(facts, claimed),
      superseded,
    };
  }
  // Liveness protects live work; authority governs the rest.
  return assigneeVerdict(facts, superseded);
}

/** Authority flows down: the assignee, or the assignee of an ancestor. */
function assigneeVerdict(
  facts: AuthorizationFacts,
  superseded: SupersededClaim | null,
): Verdict {
  const { task, ancestors, identity } = facts;
  const assignee = task.frontmatter.assignee;
  const actor = identity.actor;
  if (
    assignee === null ||
    assignee === actor ||
    ancestors.some((ancestor) => ancestor.frontmatter.assignee === actor)
  ) {
    return { admitted: true, superseded };
  }
  return { admitted: false, refusal: assigneeRefusal(facts), superseded };
}

/**
 * The claim a write goes past, for its log entry and its result; `null`
 * when the claim fields name nobody (validation reports them, and a
 * transition clears them like any claim).
 */
export function supersededClaimOf(
  shown: string,
  fm: Frontmatter,
  claimed: ClaimLiveness,
): SupersededClaim | null {
  if (fm.claimed_by === null) return null;
  return {
    id: shown,
    claimant: fm.claimed_by,
    session: fm.claimed_session,
    liveness: claimed.liveness,
    last_seen: claimed.last_seen,
  };
}

/** The `authorization` details: who holds the task, and how alive the claim is. */
export function authorizationDetailsOf(
  shown: string,
  fm: Frontmatter,
  claimed: ClaimLiveness | null,
): AuthorizationDetails {
  return {
    id: shown,
    claimed_by: fm.claimed_by,
    claimed_session: fm.claimed_session,
    assignee: fm.assignee,
    liveness: claimed?.liveness ?? null,
  };
}

/** `alice in session 7f3a (live, last seen <time>)`, for a refusal. */
export function claimText(fm: Frontmatter, claimed: ClaimLiveness): string {
  const who = fm.claimed_by ?? "nobody";
  const session =
    fm.claimed_session === null
      ? "without a session"
      : `in session ${fm.claimed_session}`;
  let state: string;
  switch (claimed.liveness) {
    case "live":
      state = `live, last seen ${claimed.last_seen ?? "just now"}`;
      break;
    case "orphaned":
      state = `orphaned, last seen ${claimed.last_seen ?? "unknown"}`;
      break;
    case "unknown":
      state =
        fm.claimed_session === null
          ? "liveness unknown"
          : "liveness unknown: no heartbeat from that session here";
      break;
  }
  return `${who} ${session} (${state})`;
}

function claimantRefusal(
  facts: AuthorizationFacts,
  claimed: ClaimLiveness,
): TaskError {
  const { task, shown, command } = facts;
  const rule =
    command === "claim"
      ? claimed.liveness === "live"
        ? "a claim on live work is refused"
        : "a claim whose liveness cannot be judged is refused"
      : `only its claimant may ${command} it`;
  return TaskError.conflict(
    `${shown} is claimed by ${claimText(task.frontmatter, claimed)}; ${rule}. Pass --force to override.`,
    {
      ...authorizationDetailsOf(shown, task.frontmatter, claimed),
      kind: "authorization",
    },
  );
}

function assigneeRefusal(facts: AuthorizationFacts): TaskError {
  const { task, shown, command, claimed } = facts;
  const assignee = task.frontmatter.assignee;
  return TaskError.conflict(
    `${shown} is assigned to ${assignee}: while it is not claimed, only ${assignee} or the assignee of an ancestor may ${command} it. Pass --force to override.`,
    {
      ...authorizationDetailsOf(shown, task.frontmatter, claimed),
      kind: "authorization",
    },
  );
}
