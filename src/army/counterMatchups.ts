import type { TargetUnit } from "../engine/types";
import { runUnitPhaseSimulation } from "../engine/simulate";
import { ROSTER, type UnitDefinition } from "./roster";
import {
  unitScenarios,
  buildEngagementsForScenario,
  DEFAULT_DAMAGE_SETTINGS,
  type DamageSettings,
} from "./engagementBuilder";

/** Lower iteration count than the main ranked-options pass — this runs many
 * more unit/scenario combinations (every ROSTER unit × every opponent unit,
 * per phase) and only needs a stable mean, not percentiles. */
const COUNTER_ITERATIONS = 300;

/** This unit's best-scoring scenario in one phase (Shooting or Melee),
 * firing ALL of its weapons for that scenario together in a shared target
 * pool — matching how a unit actually attacks (every gun in the squad, not
 * just its single hardest-hitting weapon), and avoiding double-counting
 * overkill across weapons the same way the main ranked-options list does.
 * Shooting has up to 2 scenarios (half range / full range, for
 * Melta/Rapid Fire) — each is evaluated as its own complete alpha strike and
 * the better-scoring one wins; melee has one. Reuses the same scenario
 * builder as the main ranked-options pass, filtered to the requested mode,
 * so this unit's own currently-toggled stratagems/rules apply exactly as
 * they would anywhere else (a shooting-only rule like Purgation Pattern only
 * ever affects the Shooting pick; a melee-only rule like Truesilver
 * Channelling only ever affects the Melee pick). */
function bestScenarioForMode(
  unit: UnitDefinition,
  target: TargetUnit,
  settings: DamageSettings,
  mode: "shooting" | "melee",
  halfRange?: boolean
): { damage: number; scenarioLabel: string; modelsKilled: number } {
  const scenarios = unitScenarios(unit, settings, halfRange).filter((s) => s.mode === mode);
  let best = { damage: 0, scenarioLabel: "—", modelsKilled: 0 };
  for (const { mode: m, scenario, label } of scenarios) {
    const engagements = buildEngagementsForScenario(unit, target, m, scenario);
    if (engagements.length === 0) continue;
    const summary = runUnitPhaseSimulation(
      engagements.map((e) => ({ ctx: e.ctx, rerolls: e.rerolls })),
      { label: `${unit.name} — ${label}`, iterations: COUNTER_ITERATIONS }
    );
    if (summary.meanDamage > best.damage) {
      best = { damage: summary.meanDamage, scenarioLabel: label, modelsKilled: summary.meanModelsKilled };
    }
  }
  return best;
}

export interface CounterRankedUnit {
  unitId: string;
  unitName: string;
  unitPoints: number;
  damage: number;
  dmgPerPoint: number;
  /** Which range band / stratagem combo this unit's damage reflects — e.g.
   * "half range" or "melee, Truesilver Channelling (2CP)" — since the damage
   * figure is now this unit's ALL-weapons combined total for that scenario,
   * not a single weapon's name. */
  scenarioLabel: string;
  /** Expected number of the OPPONENT unit's models destroyed — a separate
   * result from raw damage, since damage alone doesn't say how many actual
   * models die (overkill on a single model wastes damage that would have
   * killed a second model if spread out, and vice versa a unit's wounds
   * being larger than one weapon's typical hit means damage can pile up
   * without killing anything at all). Computed from the same combined-fire
   * scenario as the damage figure, not independently optimized. */
  modelsKilled: number;
}

/** One specific (my unit, opponent target, phase) calculation — exported so
 * a single row's stratagem toggle can be recomputed and re-sorted in place
 * without touching any other unit's row, any other opponent's card, or the
 * other phase's section. Returns null only if the unit id doesn't exist. */
export function computeUnitCounterEntry(
  unitId: string,
  target: TargetUnit,
  settings: DamageSettings,
  mode: "shooting" | "melee",
  halfRange?: boolean
): CounterRankedUnit | null {
  const unit = (ROSTER as UnitDefinition[]).find((u) => u.id === unitId);
  if (!unit) return null;
  const { damage, scenarioLabel, modelsKilled } = bestScenarioForMode(unit, target, settings, mode, halfRange);
  return {
    unitId: unit.id,
    unitName: unit.name,
    unitPoints: unit.points,
    damage,
    dmgPerPoint: damage / Math.max(unit.points, 1),
    scenarioLabel,
    modelsKilled,
  };
}

/** Primary sort: raw expected damage into this specific opponent unit.
 * Tiebreak: when two of my units are within ~8% of each other on raw
 * damage, points efficiency decides — so points act as a sanity-check
 * tiebreaker rather than a replacement for the damage math (an unambiguously
 * bigger hitter still wins outright, and the same expensive generalist
 * doesn't automatically dominate every matchup). Exported on its own (not
 * bundled with the top-3 slice) so a set of already-displayed rows can be
 * re-sorted after one of them changes, without dropping/adding rows. */
const NEAR_TIE_BAND = 0.08;

export function sortCounterEntries(entries: CounterRankedUnit[]): CounterRankedUnit[] {
  return [...entries].sort((a, b) => {
    const scale = Math.max(a.damage, b.damage, 0.01);
    if (Math.abs(a.damage - b.damage) > scale * NEAR_TIE_BAND) {
      return b.damage - a.damage;
    }
    return b.dmgPerPoint - a.dmgPerPoint;
  });
}

function rankTop3(entries: CounterRankedUnit[]): CounterRankedUnit[] {
  return sortCounterEntries(entries).slice(0, 3);
}

/** Purgation Squad is the only unit eligible for the Focused Immolation
 * stratagem, but it doesn't always crack the raw-damage top 3 — when it
 * doesn't, its row (and with it, the only checkbox that can turn Focused
 * Immolation on) never appears at all, making the stratagem effectively
 * undiscoverable even though it works correctly once toggled. Always keep
 * one Purgation Squad copy visible in the Shooting section so that toggle
 * stays reachable, without cluttering results with all 3 copies. */
const ALWAYS_SHOW_SHOOTING_UNIT_IDS = ["purgation-squad-a", "purgation-squad-b", "purgation-squad-c"];

function rankForMode(
  target: TargetUnit,
  mode: "shooting" | "melee",
  resolveSettings: (unitId: string) => DamageSettings,
  halfRange?: boolean
): CounterRankedUnit[] {
  const scores: CounterRankedUnit[] = (ROSTER as UnitDefinition[]).map((u) => {
    const { damage, scenarioLabel, modelsKilled } = bestScenarioForMode(u, target, resolveSettings(u.id), mode, halfRange);
    return {
      unitId: u.id,
      unitName: u.name,
      unitPoints: u.points,
      damage,
      dmgPerPoint: damage / Math.max(u.points, 1),
      scenarioLabel,
      modelsKilled,
    };
  });
  const top3 = rankTop3(scores);
  if (mode !== "shooting" || top3.some((t) => ALWAYS_SHOW_SHOOTING_UNIT_IDS.includes(t.unitId))) {
    return top3;
  }
  const bestPurgation = scores
    .filter((s) => ALWAYS_SHOW_SHOOTING_UNIT_IDS.includes(s.unitId))
    .sort((a, b) => b.damage - a.damage)[0];
  return bestPurgation ? [...top3, bestPurgation] : top3;
}

export interface PhaseCounterMatchups {
  shooting: CounterRankedUnit[];
  melee: CounterRankedUnit[];
}

/** For one opponent unit, my ROSTER's top 3 counters — computed
 * independently for Shooting and Melee (a unit's ranged profiles never
 * factor into its Melee score and vice versa), each scored by that phase's
 * best all-weapons-combined scenario fired at this specific target's actual
 * stat line. `getUnitSettings` is mode-aware so the Shooting and Melee
 * calculation for the same unit can carry entirely independent toggles. */
export function computeTopCounters(
  target: TargetUnit,
  getUnitSettings?: (unitId: string, mode: "shooting" | "melee") => DamageSettings,
  halfRange?: boolean
): PhaseCounterMatchups {
  const resolve = getUnitSettings ?? (() => DEFAULT_DAMAGE_SETTINGS);
  return {
    // Half range only ever affects shooting (Rapid Fire / Melta); melee is
    // range-agnostic, so the override is deliberately not passed there.
    shooting: rankForMode(target, "shooting", (id) => resolve(id, "shooting"), halfRange),
    melee: rankForMode(target, "melee", (id) => resolve(id, "melee")),
  };
}
