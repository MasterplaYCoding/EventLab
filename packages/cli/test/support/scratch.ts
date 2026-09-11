import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A scratch directory *inside* the repository, for scenario modules.
 *
 * A scenario is real ESM that imports `@masterplaycoding/eventlab`, and the CLI
 * loads it with Node's own `import()`. Node resolves that bare specifier from
 * the module's directory upwards - exactly as it would in a user's project -
 * so the module has to live somewhere a `node_modules` is reachable. A
 * directory under the OS temp dir is not.
 *
 * These tests used the OS temp dir until Vitest 5, and passed only because
 * Vitest 3 resolved the import on their behalf: a resolution path no user of
 * the CLI has. `.eventlab/` is gitignored.
 */
export function scratchDirectory(prefix: string): string {
  const root = fileURLToPath(new URL("../../../../.eventlab/test-scratch/", import.meta.url));
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}
