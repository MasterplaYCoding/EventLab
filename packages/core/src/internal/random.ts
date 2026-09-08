/**
 * A deterministic 32-bit PRNG (mulberry32).
 *
 * The planner is the only part of EventLab allowed to consume randomness, and
 * it consumes it in a fixed order, so the same seed and the same transform
 * declaration always expand to the same plan. Execution never draws from a
 * random source: anything that varies at run time is observed and reported,
 * not chosen.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  nextInt(min: number, max: number): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    nextInt(min, max) {
      if (max < min) {
        throw new RangeError(`nextInt requires min <= max, received ${min} > ${max}`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
  };
}

/**
 * Fisher-Yates shuffle driven by {@link Rng}. Returns a new array and never
 * mutates the input, so a transform chain can be inspected step by step.
 */
export function shuffleWith<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(0, i);
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}
