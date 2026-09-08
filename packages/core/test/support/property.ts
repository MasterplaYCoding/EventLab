/**
 * How many cases each fast-check property explores.
 *
 * Pull requests use fast-check's default so that a failure is reproducible
 * from the seed printed in the log. The scheduled sweep raises this via
 * EVENTLAB_PROPERTY_RUNS to search wider than a per-PR budget allows.
 */
export const propertyRuns = Number(process.env.EVENTLAB_PROPERTY_RUNS ?? 100);

export const propertyConfig = { numRuns: propertyRuns } as const;
