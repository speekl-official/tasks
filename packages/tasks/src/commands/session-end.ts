import { Command } from "commander";

import { openContext, requireSession } from "../context.js";
import { sessionEnd } from "../core/sessions.js";
import { emitJson, renderSessionEnd, writeOut } from "../output.js";

export function sessionEndCommand(): Command {
  return new Command("session-end")
    .description(
      "mark the current session ended in this tree and every listed one, orphaning its claims at once, and list them; needs a session",
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (_options: unknown, command: Command) => {
      const session = requireSession(command, "session-end");
      // Opening the context touched the registries first; the mark written
      // now is what tells the next session that this one said goodbye.
      const context = await openContext(command);
      const trees = (await context.trees()).map((load) => ({
        tree: load.tree,
        alias: context.projects.qualifier(load),
      }));
      const result = await sessionEnd(trees, session);

      if (context.json) {
        emitJson(result);
        return;
      }
      writeOut(renderSessionEnd(result));
    });
}
