import { Ledger } from "../../src/webhook";

/**
 * Where the route finds its state.
 *
 * Next constructs route modules itself, so there is no constructor to hand a
 * dependency to, and a route file may only export route handlers. A real
 * application keeps this in a database that the route and the test both reach.
 * The recipe keeps it in memory, so a process-wide slot stands in for that
 * database: the test puts a fresh ledger here before each run, and the route
 * reads whatever is here when a delivery arrives.
 */
const SLOT = Symbol.for("eventlab.recipes.nextjs.ledger");

type Slot = { [SLOT]?: Ledger };

export function currentLedger(): Ledger {
  const slot = globalThis as Slot;
  return (slot[SLOT] ??= new Ledger());
}

export function useLedger(ledger: Ledger): void {
  (globalThis as Slot)[SLOT] = ledger;
}
