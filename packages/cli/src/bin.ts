#!/usr/bin/env node
import { run } from "./index.js";

/**
 * The executable wrapper.
 *
 * Kept to nothing but wiring so that `run` stays a pure function of its
 * arguments and streams, and can therefore be tested without spawning a
 * process or capturing global stdout.
 */
const code = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});

process.exitCode = code;
