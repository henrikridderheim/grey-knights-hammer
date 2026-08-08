import { makeRng } from "./dice";
import { simulateEngagement, type RerollFlags } from "./attackSequence";
import type { AttackContext, SimulationSummary } from "./types";

export interface RunOptions {
  label: string;
  iterations?: number;
  seed?: number;
  rerolls?: RerollFlags;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stdDev(values: number[], avg: number): number {
  if (values.length === 0) return 0;
  const variance = mean(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

export function runSimulation(ctx: AttackContext, options: RunOptions): SimulationSummary {
  const iterations = options.iterations ?? 10000;
  const rng = makeRng(options.seed ?? 12345);

  const damages: number[] = [];
  const modelsKilledList: number[] = [];
  const woundsRemainingList: number[] = [];
  let kills = 0;
  let wipes = 0;

  for (let i = 0; i < iterations; i++) {
    const result = simulateEngagement(ctx, rng, options.rerolls);
    damages.push(result.damageDealt);
    modelsKilledList.push(result.modelsKilled);
    woundsRemainingList.push(result.woundsRemaining);
    if (result.unitWiped) {
      kills += 1;
      wipes += 1;
    }
  }

  const sortedDamage = [...damages].sort((a, b) => a - b);
  const avgDamage = mean(damages);

  return {
    label: options.label,
    iterations,
    meanDamage: avgDamage,
    medianDamage: median(sortedDamage),
    stdDevDamage: stdDev(damages, avgDamage),
    p10: percentile(sortedDamage, 10),
    p25: percentile(sortedDamage, 25),
    p75: percentile(sortedDamage, 75),
    p90: percentile(sortedDamage, 90),
    killProbability: kills / iterations,
    meanModelsKilled: mean(modelsKilledList),
    meanWoundsRemaining: mean(woundsRemainingList),
    wipeProbability: wipes / iterations,
  };
}
