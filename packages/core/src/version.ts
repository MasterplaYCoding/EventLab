/**
 * Version of the planning algorithm. A saved {@link DeliveryPlan} records the
 * planner version that produced it, and replay refuses to regenerate a plan
 * with a different planner rather than silently producing different traffic.
 */
export const PLANNER_VERSION = "1";

/**
 * Version of the JSON run report schema. Consumers that parse reports should
 * branch on this value rather than on the toolkit version.
 */
export const REPORT_SCHEMA_VERSION = "1";
