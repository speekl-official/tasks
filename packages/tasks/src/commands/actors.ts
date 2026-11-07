import { Command } from "commander";

import { descriptionOf, isListed, listedActors } from "../core/actors.js";
import { hasOpenStatus } from "../core/derive.js";
import type { ActorJson, ActorsJson } from "../core/types.js";
import { emitJson, renderActors, ui, writeOut } from "../output.js";
import {
  openSpan,
  spanTasks,
  spannedAliases,
  unavailableOf,
  unavailableText,
} from "./overview.js";

interface ActorsOptions {
  local?: boolean;
  json?: boolean;
}

interface Counts {
  claimed: number;
  assigned: number;
}

/**
 * Who is around: the actors `config.yml` lists, with their descriptions and
 * how many open tasks each is working on or must act on; then every other
 * actor an open task names — a name to add to the roster, or one to
 * correct — and the caller. The roster is the local tree's; the counts
 * span the listed projects, as `mine` does, unless `--local`.
 */
export function actorsCommand(): Command {
  return new Command("actors")
    .description(
      "the actors config.yml lists, with what each works on or must act on, and every other actor an open task names; spans the listed projects",
    )
    .option("--local", "the local tree only, not the projects it lists")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: ActorsOptions, command: Command) => {
      // Not scoped: who is around does not depend on what is worked next.
      const span = await openSpan(command, options, false);
      const { context } = span;
      const config = context.tree.config;

      const counts = new Map<string, Counts>();
      const tally = (actor: string, field: keyof Counts): void => {
        const entry = counts.get(actor) ?? { claimed: 0, assigned: 0 };
        entry[field] += 1;
        counts.set(actor, entry);
      };
      for (const d of spanTasks(span)) {
        if (!hasOpenStatus(d)) continue;
        const fm = d.snapshot.task.frontmatter;
        if (fm.claimed_by !== null) tally(fm.claimed_by, "claimed");
        if (fm.assignee !== null) tally(fm.assignee, "assigned");
      }

      const others = [...counts.keys(), context.identity.actor]
        .filter((actor) => !isListed(config, actor))
        .sort();
      const names = new Set([...listedActors(config), ...others]);
      const rows: ActorJson[] = [...names].map((actor) => ({
        actor,
        description: descriptionOf(config, actor),
        listed: isListed(config, actor),
        claimed: counts.get(actor)?.claimed ?? 0,
        assigned: counts.get(actor)?.assigned ?? 0,
      }));
      const result: ActorsJson = {
        actor: context.identity.actor,
        via: context.identity.via,
        projects: spannedAliases(span),
        actors: rows,
        unavailable: unavailableOf(span),
      };

      if (context.json) {
        emitJson(result);
        return;
      }
      writeOut(renderActors(result));
      for (const load of span.unavailable) {
        writeOut(ui.warn(unavailableText(load)));
      }
    });
}
