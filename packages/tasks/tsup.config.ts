import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // package.json is the single source of truth for the version; src/cli.ts
  // reads it through this define so a release bump cannot drift from `-v`.
  define: { __PKG_VERSION__: JSON.stringify(version) },
  banner: { js: "#!/usr/bin/env node" },
});
