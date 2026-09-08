import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    // Examples bind real loopback sockets, so give each file its own process
    // rather than sharing one and fighting over ports.
    pool: "forks",
    testTimeout: 20_000,
  },
});
