import { fileURLToPath } from "node:url";

/**
 * The route imports the webhook logic every recipe shares, which lives one
 * directory up - outside this Next project. Turbopack only compiles files
 * under its root, so the root is widened to include it. An application with
 * its code inside the project needs none of this.
 */
export default {
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
};
