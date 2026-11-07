import { Command } from "commander";

import { openContext, requireSession } from "../context.js";
import { emitJson, ui, writeOut } from "../output.js";

/** What `heartbeat --json` prints. */
export interface HeartbeatJson {
  session: string;
  /** The `.tasks/` directories whose registry was touched. */
  touched: string[];
}

export function heartbeatCommand(): Command {
  return new Command("heartbeat")
    .description(
      "record that the current session is alive, in this tree and every listed one; needs a session (a harness runs it after every tool call)",
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (_options: unknown, command: Command) => {
      const session = requireSession(command, "heartbeat");
      // Opening the context is the heartbeat: every command with a session
      // touches the registry of each tree it can see before its own work,
      // so there is nothing left to do but report where.
      const context = await openContext(command);
      const touched = (await context.trees()).map(
        (load) => load.project.tasksDir,
      );

      if (context.json) {
        const result: HeartbeatJson = { session, touched };
        emitJson(result);
        return;
      }
      const trees = touched.length === 1 ? "1 tree" : `${touched.length} trees`;
      writeOut(ui.success(`session ${session} is alive in ${trees}`));
    });
}
