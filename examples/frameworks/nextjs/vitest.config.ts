import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The Next.js recipe's own test configuration.
 *
 * The root config matches `examples/*\/test`, which this directory is one
 * level too deep to be caught by - deliberately, so a checkout without Next
 * installed still passes `npm test`.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
});
