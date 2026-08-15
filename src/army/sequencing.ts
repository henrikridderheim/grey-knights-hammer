import type { AttackContext } from "../engine/types";
import type { RerollFlags } from "../engine/attackSequence";
import { runUnitPhaseSimulation } from "../engine/simulate";
import type { WeaponEngagement } from "./engagementBuilder";

/**
 * Recommends what order to resolve a unit's distinct weapon profiles in
 * against one target, to minimize damage wasted to overkill and maximize
 * expected models slain — reusing `runUnitPhaseSimulation`, the exact same
 * shared-pool, capped-damage engine the "Models Slain" stat already uses
 * (excess damage from a single attack doesn't carry to another model, per
 * the standard 40k rule). This is NOT the uncapped "Damage Dealt" weapon
 * breakdown number — sequencing is specifically about overkill, so it has
 * to use the capped model.
 *
 * Firing order matters because each weapon resolves as one full volley
 * against whatever pool state the previous weapons left behind: a
 * low-shot-count/high-damage weapon (Melta, etc.) fired into a model
 * something else is about to finish off wastes its extra damage as
 * overkill; fired into a fresh model, that damage is fully used. Which
 * order is actually best depends on the specific attacks/wounds/damage
 * values involved, so this is computed, not assumed.
 */

const SEQUENCING_ITERATIONS = 200;
/** Above this many distinct (post-merge) weapon profiles, exhaustive
 * permutation search (N!) gets too slow for an on-demand UI action — fall
 * back to a greedy build instead (see `greedySequence`). 6! = 720
 * permutations, still tractable at a couple hundred iterations each. */
const MAX_EXHAUSTIVE_ENGAGEMENTS = 6;
/** Fixed across every candidate order evaluated in one call, so comparisons
 * aren't just comparing independent dice noise. */
const SEQUENCING_SEED = 7331;

interface MergedEngagement {
  /** Display label — the bare weapon name if multiple loadouts using the
   * identical profile were merged together (their relative order among
   * themselves never mattered), or the original per-loadout label if this
   * weapon appeared only once. */
  label: string;
  ctx: AttackContext;
  rerolls?: RerollFlags;
}

function mergeKey(ctx: AttackContext): string {
  return [
    ctx.weapon.name,
    ctx.halfRange,
    ctx.hitMod,
    ctx.woundMod,
    ctx.strengthBonus,
    ctx.attacksBonus ?? 0,
    ctx.bonusSustainedHits ?? 0,
    ctx.grantDevastatingWounds ?? false,
    ctx.apReduction ?? 0,
    ctx.damageReduction ?? 0,
    ctx.usePrecisionOnCharacter ?? false,
  ].join("|");
}

/** Weapons with identical profiles and modifiers (e.g. the same "Purifying
 * Flame" fired by 3 different loadout groups in one unit) don't need their
 * order relative to EACH OTHER considered — firing them in any order among
 * themselves gives an identical result, only their order relative to
 * DIFFERENT weapon types matters. Merging them shrinks the permutation
 * space without losing any accuracy. */
function mergeIdenticalEngagements(engagements: WeaponEngagement[]): MergedEngagement[] {
  const merged = new Map<string, MergedEngagement & { mergeCount: number }>();
  for (const e of engagements) {
    const key = mergeKey(e.ctx);
    const existing = merged.get(key);
    if (existing) {
      existing.ctx = { ...existing.ctx, numAttackingModels: existing.ctx.numAttackingModels + e.ctx.numAttackingModels };
      existing.mergeCount += 1;
      existing.label = e.ctx.weapon.name;
    } else {
      merged.set(key, { label: e.weaponLabel, ctx: { ...e.ctx }, rerolls: e.rerolls, mergeCount: 1 });
    }
  }
  return [...merged.values()].map(({ mergeCount: _mergeCount, ...rest }) => rest);
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) result.push([items[i], ...p]);
  }
  return result;
}

function scoreOrder(order: MergedEngagement[]): { meanDamage: number; meanModelsKilled: number } {
  const summary = runUnitPhaseSimulation(
    order.map((e) => ({ ctx: e.ctx, rerolls: e.rerolls })),
    { label: "sequencing", iterations: SEQUENCING_ITERATIONS, seed: SEQUENCING_SEED }
  );
  return { meanDamage: summary.meanDamage, meanModelsKilled: summary.meanModelsKilled };
}

/** Primary: mean damage. This looks like it should be models-killed first
 * (that's the headline goal), but empirically it's the wrong primary sort
 * key — verified directly against this module before shipping it: on a
 * 3-model/W3-each target, one order gave 4.20 mean damage vs. 3.42 for the
 * other (a real, large, order-driven difference — exactly what this feature
 * exists to find), while mean-models-killed for the SAME two orders came out
 * 1.040 vs. 1.045 — indistinguishable noise around the same true value at
 * `SEQUENCING_ITERATIONS`. Models-killed is a coarse, saturating function of
 * damage — it often ties between orders even when overkill avoidance made a
 * substantial difference — so sorting by it first meant picking orders
 * based on which side of the noise floor a coin flip landed on, and threw
 * away the much bigger, real signal in damage. Raising iterations enough to
 * make models-killed reliably discriminating would make exhaustive
 * permutation search too slow for an on-demand UI action, so damage is the
 * primary signal; models-killed only breaks an exact damage tie. */
function isBetter(
  a: { meanDamage: number; meanModelsKilled: number },
  b: { meanDamage: number; meanModelsKilled: number }
): boolean {
  if (a.meanDamage !== b.meanDamage) return a.meanDamage > b.meanDamage;
  return a.meanModelsKilled > b.meanModelsKilled;
}

/** Greedy fallback for units with more distinct weapon profiles than
 * exhaustive search can handle: repeatedly pick whichever remaining weapon,
 * appended next to the prefix chosen so far, scores best — O(N^2)
 * evaluations instead of O(N!). Not guaranteed globally optimal, but a
 * strong, fast approximation. */
function greedySequence(merged: MergedEngagement[]): MergedEngagement[] {
  const remaining = [...merged];
  const chosen: MergedEngagement[] = [];
  while (remaining.length > 0) {
    let bestIdx = 0;
    let best: { meanDamage: number; meanModelsKilled: number } | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = scoreOrder([...chosen, remaining[i]]);
      if (!best || isBetter(candidate, best)) {
        best = candidate;
        bestIdx = i;
      }
    }
    chosen.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return chosen;
}

export interface SequencingResult {
  /** Empty when the unit has 0 or 1 distinct weapon profiles for this
   * scenario — there's nothing to sequence, so the caller should treat this
   * as "not applicable" rather than render it. */
  applicable: boolean;
  optimalOrder: string[];
  optimalMeanDamage: number;
  optimalMeanModelsKilled: number;
  naiveOrder: string[];
  naiveMeanDamage: number;
  naiveMeanModelsKilled: number;
  /** True when the result came from the greedy approximation (too many
   * distinct weapons for exhaustive search) rather than a guaranteed-optimal
   * exhaustive permutation search. */
  usedGreedyFallback: boolean;
  permutationsEvaluated: number;
}

/** Computes the firing order (among this unit's distinct weapon profiles)
 * that maximizes expected models slain against the given target, alongside
 * the naive (input/default order) result for comparison. Expensive relative
 * to the rest of this app's calculations (exhaustive permutation search) —
 * intended to be triggered on demand, not computed eagerly for every
 * result. */
export function computeOptimalSequencing(engagements: WeaponEngagement[]): SequencingResult {
  const merged = mergeIdenticalEngagements(engagements);

  if (merged.length <= 1) {
    const summary = merged.length === 1 ? scoreOrder(merged) : { meanDamage: 0, meanModelsKilled: 0 };
    const labels = merged.map((e) => e.label);
    return {
      applicable: false,
      optimalOrder: labels,
      optimalMeanDamage: summary.meanDamage,
      optimalMeanModelsKilled: summary.meanModelsKilled,
      naiveOrder: labels,
      naiveMeanDamage: summary.meanDamage,
      naiveMeanModelsKilled: summary.meanModelsKilled,
      usedGreedyFallback: false,
      permutationsEvaluated: merged.length,
    };
  }

  const naive = scoreOrder(merged);

  if (merged.length <= MAX_EXHAUSTIVE_ENGAGEMENTS) {
    const perms = permutations(merged);
    let bestOrder = perms[0];
    let best = scoreOrder(bestOrder);
    for (const perm of perms.slice(1)) {
      const candidate = scoreOrder(perm);
      if (isBetter(candidate, best)) {
        best = candidate;
        bestOrder = perm;
      }
    }
    return {
      applicable: true,
      optimalOrder: bestOrder.map((e) => e.label),
      optimalMeanDamage: best.meanDamage,
      optimalMeanModelsKilled: best.meanModelsKilled,
      naiveOrder: merged.map((e) => e.label),
      naiveMeanDamage: naive.meanDamage,
      naiveMeanModelsKilled: naive.meanModelsKilled,
      usedGreedyFallback: false,
      permutationsEvaluated: perms.length,
    };
  }

  const greedyOrder = greedySequence(merged);
  const greedyScore = scoreOrder(greedyOrder);
  return {
    applicable: true,
    optimalOrder: greedyOrder.map((e) => e.label),
    optimalMeanDamage: greedyScore.meanDamage,
    optimalMeanModelsKilled: greedyScore.meanModelsKilled,
    naiveOrder: merged.map((e) => e.label),
    naiveMeanDamage: naive.meanDamage,
    naiveMeanModelsKilled: naive.meanModelsKilled,
    usedGreedyFallback: true,
    permutationsEvaluated: merged.length * (merged.length + 1) / 2,
  };
}
