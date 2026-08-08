import type { DiceSpec } from "./types";

/** Deterministic, seedable PRNG (mulberry32) so unit tests are reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function d6(rng: () => number): number {
  return Math.floor(rng() * 6) + 1;
}

export function d3(rng: () => number): number {
  return Math.floor(rng() * 3) + 1;
}

export function rollDiceSpec(spec: DiceSpec, rng: () => number): number {
  if (typeof spec === "number") return spec;
  const base = spec.dice === "D3" ? d3(rng) : d6(rng);
  return base + (spec.flat ?? 0);
}

/** Average value of a dice spec, for display purposes (not used in simulation itself). */
export function averageDiceSpec(spec: DiceSpec): number {
  if (typeof spec === "number") return spec;
  const base = spec.dice === "D3" ? 2 : 3.5;
  return base + (spec.flat ?? 0);
}
