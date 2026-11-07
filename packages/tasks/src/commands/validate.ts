import { Command } from "commander";

import { openContext } from "../context.js";
import { validateTree } from "../core/validate.js";
import { ExitCode } from "../errors.js";
import { emitJson, renderValidation, writeOut } from "../output.js";

interface ValidateOptions {
  fix?: boolean;
  json?: boolean;
}

export function validateCommand(): Command {
  return new Command("validate")
    .description(
      "check the tree against the convention; exits 4 when an error is found, 0 on warnings alone",
    )
    .option(
      "--fix",
      "regenerate index.md when it exists and is out of date; nothing else is ever repaired",
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (options: ValidateOptions, command: Command) => {
      const context = await openContext(command);
      const result = await validateTree(context, { fix: options.fix === true });

      if (context.json) emitJson(result);
      else writeOut(renderValidation(result));

      // The findings are the command's output, not a failure of the command:
      // the code is set after printing them instead of thrown in their place.
      if (!result.ok) process.exitCode = ExitCode.Conflict;
    });
}
