import { Command } from "commander";

import type { DerivedTask } from "../core/derive.js";
import { hasOpenStatus, readyComparator } from "../core/derive.js";
import type { Identity } from "../core/types.js";
import { renderMine } from "../output.js";
import { emitOverview, openSpan, spanTasks } from "./overview.js";

interface MineOptions {
  local?: boolean;
  json?: boolean;
}

/** An open task the actor works on (claimant) or must act on (assignee). */
function isMine(d: DerivedTask, actor: string): boolean {
  const fm = d.snapshot.task.frontmatter;
  return hasOpenStatus(d) && (fm.claimed_by === actor || fm.assignee === actor);
}

/**
 * The entry protocol's order: claims of this very session first (continue
 * them), then the actor's other claims (orphaned ones are taken over before
 * new work), then the inbox of tasks merely assigned. Without a session,
 * "this session" is the claims that carry none, as for `session-check`.
 */
function claimRank(d: DerivedTask, identity: Identity): number {
  const fm = d.snapshot.task.frontmatter;
  if (fm.status !== "IN_PROGRESS" || fm.claimed_by !== identity.actor) {
    return 2;
  }
  return fm.claimed_session === identity.session ? 0 : 1;
}

export function mineCommand(): Command {
  return new Command("mine")
    .description(
      "open tasks you have claimed or are assigned, each with its situation and last log entry; spans the listed projects",
    )
    .option("--local", "the local tree only, not the projects it lists")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: MineOptions, command: Command) => {
      // The configured scope narrows what to take next, not what is yours.
      const span = await openSpan(command, options, false);
      const { identity, projects } = span.context;
      const aliasOrder = projects.aliases();
      const rows = spanTasks(span)
        .filter((d) => isMine(d, identity.actor))
        .sort(
          (a, b) =>
            claimRank(a, identity) - claimRank(b, identity) ||
            readyComparator(a, b, aliasOrder),
        );
      emitOverview(span, rows, (shown) => renderMine(shown, { project: true }));
    });
}
