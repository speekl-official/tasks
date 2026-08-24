import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  // Mirrors the tsup define so tests see the same version the build ships.
  define: { __PKG_VERSION__: JSON.stringify(version) },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
