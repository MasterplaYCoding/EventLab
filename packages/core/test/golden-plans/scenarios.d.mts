import type * as EventLab from "../../src/index.js";

export function scenarios(
  library: Pick<typeof EventLab, "createPlan" | "duplicate" | "shuffle" | "delay" | "burst">,
): { name: string; plan: EventLab.DeliveryPlan }[];
