import path from "node:path";

import { Command } from "commander";

import { openContext } from "../context.js";
import { reindexTree } from "../core/validate.js";
import { emitJson, ui, writeOut } from "../output.js";

export function reindexCommand(): Command {
  return new Command("reindex")
    .description(
      "regenerate .tasks/index.md from the task directories, creating it if needed",
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (_options: { json?: boolean }, command: Command) => {
      const context = await openContext(command);
      const file = await reindexTree(context);

      if (context.json) {
        emitJson({ path: file, written: true });
        return;
      }
      // Relative to the project root, which `-C` may have named from afar.
      const shown = path
        .relative(context.project.root, file)
        .split(path.sep)
        .join("/");
      writeOut(ui.success(`wrote ${shown}`));
    });
}
