import { describe, expect, it } from "vitest";
import vm from "node:vm";

import { describeCause } from "../src/internal/describeCause.js";

/**
 * What a failing run prints when user code throws.
 *
 * This is the last step between an assertion's `throw new Error(...)` and the
 * line a person reads, so getting it wrong degrades every failure message at
 * once and is invisible in a passing suite.
 */
describe("describeCause", () => {
  it("returns the message of an ordinary error", () => {
    expect(describeCause(new Error("expected 2 fulfilment writes, found 3"))).toBe(
      "expected 2 fulfilment writes, found 3",
    );
  });

  it("appends a nested cause, which usually carries the specific detail", () => {
    // `fetch failed` on its own tells you nothing; ECONNREFUSED tells you
    // the app was not listening.
    const cause = new Error("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:3000") });

    expect(describeCause(cause)).toBe("fetch failed: ECONNREFUSED 127.0.0.1:3000");
  });

  it("does not repeat a nested cause that says the same thing", () => {
    const cause = new Error("boom", { cause: new Error("boom") });

    expect(describeCause(cause)).toBe("boom");
  });

  it("ignores a nested cause that is not an error", () => {
    const cause = new Error("boom", { cause: "some string" });

    expect(describeCause(cause)).toBe("boom");
  });

  it("stringifies things that were thrown but are not errors", () => {
    // `throw "oops"` is legal and people do it.
    expect(describeCause("oops")).toBe("oops");
    expect(describeCause(42)).toBe("42");
    expect(describeCause(null)).toBe("null");
    expect(describeCause(undefined)).toBe("undefined");
  });

  it("keeps the message of an error thrown in another realm", () => {
    // The reason this helper exists. `cause instanceof Error` is false across
    // a realm boundary, so all three previous copies fell through to
    // String(cause) and printed the class name glued to the front of a
    // message the user wrote. A scenario module may well run the application
    // under test inside a vm context.
    const context = vm.createContext({});
    const foreign = vm.runInContext(
      `new Error("expected 1 fulfilment, found 2");`,
      context,
    ) as unknown;

    expect(foreign instanceof Error).toBe(false);
    expect(String(foreign)).toBe("Error: expected 1 fulfilment, found 2");
    expect(describeCause(foreign)).toBe("expected 1 fulfilment, found 2");
  });

  it("survives an error with no usable message", () => {
    const broken = new Error("x");
    Object.defineProperty(broken, "message", { value: undefined });

    // Whatever it returns, it must be a string and must not throw.
    expect(typeof describeCause(broken)).toBe("string");
  });
});
