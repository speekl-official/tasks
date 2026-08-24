import path from "node:path";

import { Command } from "commander";

import { openTree } from "../context.js";
import { writeIndex } from "../core/index-md.js";
import { emitJson, ui, writeOut } from "../output.js";

export function reindexCommand(): Command {
  return new Command("reindex")
    .description("regenerate _index.md from task frontmatter")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const tree = await openTree();
      const file = await writeIndex(tree);

      if (options.json) {
        emitJson({ path: file, tasks: tree.tasks.length });
        return;
      }

      writeOut(
        ui.success(
          `Wrote ${ui.bold(path.relative(process.cwd(), file))} (${tree.tasks.length} task(s))`,
        ),
      );
    });
}
