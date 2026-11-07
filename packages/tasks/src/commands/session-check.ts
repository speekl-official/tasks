import { Command } from "commander";

import { openContext } from "../context.js";
import { sessionCheck } from "../core/sessions.js";
import { ExitCode } from "../errors.js";
import { emitJson, renderSessionCheck, writeOut } from "../output.js";

export function sessionCheckCommand(): Command {
  return new Command("session-check")
    .description(
      "the exit invariant: every task the current session claimed has a state.md (without a session: the actor's claims that carry none); exit 4 on violations",
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (_options: unknown, command: Command) => {
      const context = await openContext(command);
      const trees = (await context.trees()).map((load) => ({
        tree: load.tree,
        alias: context.projects.qualifier(load),
      }));
      const result = await sessionCheck(trees, context.identity);

      if (context.json) emitJson(result);
      else writeOut(renderSessionCheck(result));
      // A failed check is the command's answer, printed in full on stdout;
      // the exit code is what a Stop hook branches on.
      if (!result.ok) process.exitCode = ExitCode.Conflict;
    });
}
