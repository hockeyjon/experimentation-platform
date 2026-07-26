// Deterministic variant assignment — the core of an experimentation platform.
//
// Requirements a real A/B system must satisfy:
//   1. Deterministic: the same user always lands in the same variant (no flicker).
//   2. Weighted: respect each variant's traffic weight (e.g. 50/50, 90/10).
//   3. Independent per experiment: a user's bucket in experiment A must not
//      correlate with their bucket in experiment B (otherwise results are biased).
//
// We hash `experimentKey:userId` into a stable number in [0, 1), then walk the
// weighted variants until we cross that point. Salting the hash with the
// experiment key gives independence across experiments for free.
import { createHash } from "node:crypto";

export interface WeightedVariant {
  key: string;
  weight: number;
}

// Map an arbitrary string to a stable float in [0, 1).
function hashToUnitInterval(input: string): number {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 8);
  const int = parseInt(hex, 16); // 32-bit value from the first 8 hex chars
  return int / 0xffffffff;
}

// Pick a variant key for a user, respecting weights. Returns null if there are no variants.
export function pickVariant(
  experimentKey: string,
  userId: string,
  variants: WeightedVariant[],
): string | null {
  if (variants.length === 0) return null;

  const totalWeight = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (totalWeight <= 0) return variants[0].key; // all-zero weights: fall back to first

  const point = hashToUnitInterval(`${experimentKey}:${userId}`) * totalWeight;

  let cumulative = 0;
  for (const v of variants) {
    cumulative += Math.max(0, v.weight);
    if (point < cumulative) return v.key;
  }
  return variants[variants.length - 1].key; // floating-point safety net
}
