import type { TargetUnit } from "../engine/types";
import { runWeaponBreakdown, runUnitPhaseSimulation } from "../engine/simulate";
import { ROSTER, type UnitDefinition } from "./roster";
import {
  buildEngagementsForScenario,
  unitScenarios,
  DEFAULT_DAMAGE_SETTINGS,
  type DamageSettings,
  type ScenarioFlags,
} from "./engagementBuilder";
import type { SimulationSummary } from "../engine/types";

export type SortKey = "kill" | "avgDamage" | "damagePerPoint";

/** One weapon's full attack-sequence breakdown, fired alone at a fresh
 * (uncapped-wounds) target — Attacks/Hits/Wounds Dealt/Unsaved Wounds match
 * the hobby's standard "Weapon Results" table format; `avg` (Damage Dealt)
 * is deliberately uncapped by the target's real wound pool (see
 * `uncapTargetWounds`), so it reflects the weapon's raw output rather than
 * how much of that gets used once overkill/model-death is considered. */
export interface WeaponBreakdownRow {
  label: string;
  attacks: number;
  hits: number;
  woundsDealt: number;
  unsavedWounds: number;
  avg: number;
}

export interface RankedOption {
  unitId: string;
  unitName: string;
  unitPoints: number;
  mode: "shooting" | "melee";
  scenarioLabel: string;
  summary: SimulationSummary;
  damageByWeapon: WeaponBreakdownRow[];
}

export interface CombinationOption {
  unitIds: string[];
  unitNames: string[];
  totalPoints: number;
  /** Per-unit "mode — scenario" label, so the UI can show what each unit is doing. */
  memberLabels: string[];
  summary: SimulationSummary;
}

export interface BestWayToKillItResult {
  singles: RankedOption[];
  combinations: CombinationOption[];
}

const DEFAULT_ITERATIONS = 1500;
const COMBO_ITERATIONS = 1200;
/** Per-weapon breakdown is computed "solo" — each weapon simulated alone
 * against a fresh copy of the target, not sharing the combined-fire pool —
 * so it shows what that weapon actually does, not an artifact of whatever
 * arbitrary order weapons happen to fire in within the combined simulation.
 * A weapon firing after the target is already dead in that shared-pool run
 * would otherwise show ~0 damage even though it's working correctly; solo
 * numbers don't sum to the combined total (that's expected — the combined
 * total correctly avoids double-counting overkill, the solo numbers don't
 * try to). Lower iteration count since this is informational, not the
 * primary ranking metric. */
const SOLO_WEAPON_ITERATIONS = 400;
/** Effectively-infinite per-model wounds, used only to compute the
 * "Damage Dealt" weapon breakdown figure below. That figure is meant to
 * answer "how much damage does this weapon roll per unsaved wound" (its raw
 * output — full Melta bonus, full D6+X roll, etc.), not "how much of that
 * ends up actually applied to a model with only N wounds." Simulating
 * against a target whose models can never run out of wounds means the
 * engine's normal overkill cap (excess damage from a single attack doesn't
 * carry to another model — see `applyDamageToPool`) never triggers, so the
 * full rolled damage always comes through. Kill-count/"Models Slain" stats
 * are computed separately, against the real target, and correctly keep that
 * cap — this only ever affects the weapon-breakdown display number. */
const UNCAPPED_WOUNDS = 1_000_000;

function uncapTargetWounds(target: TargetUnit): TargetUnit {
  return { ...target, groups: target.groups.map((g) => ({ ...g, wounds: UNCAPPED_WOUNDS })) };
}
/** How many of the best single units (by avg damage) to draw combinations from — bounds
 * combinatorial blow-up (C(6,2)+C(6,3) = 35 combos) while still covering the units most
 * likely to matter for a joint-fire recommendation. */
const COMBO_CANDIDATE_POOL_SIZE = 6;

interface BestPerUnit {
  unit: UnitDefinition;
  mode: "shooting" | "melee";
  scenario: ScenarioFlags;
  label: string;
  option: RankedOption;
}

export function computeBestWayToKillIt(
  target: TargetUnit,
  options: {
    iterations?: number;
    comboIterations?: number;
    /** Resolves each ROSTER unit's own stratagem/rule toggles — settings are
     * per-unit, not one global set applied to everything. Defaults every
     * unit to DEFAULT_DAMAGE_SETTINGS (all off) when omitted. */
    getUnitSettings?: (unitId: string) => DamageSettings;
    /** Manual half-range toggle for range-sensitive (Rapid Fire / Melta)
     * shooting: true = half range, false = full range. When omitted, both
     * range bands are auto-enumerated as separate options (legacy behaviour). */
    halfRange?: boolean;
  } = {}
): BestWayToKillItResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const comboIterations = options.comboIterations ?? COMBO_ITERATIONS;
  const getUnitSettings = options.getUnitSettings ?? (() => DEFAULT_DAMAGE_SETTINGS);
  const halfRange = options.halfRange;
  const results: RankedOption[] = [];
  const bestPerUnit = new Map<string, BestPerUnit>();
  const uncappedTarget = uncapTargetWounds(target);

  for (const unit of ROSTER as UnitDefinition[]) {
    const settings = getUnitSettings(unit.id);
    for (const { mode, scenario, label } of unitScenarios(unit, settings, halfRange)) {
      const engagements = buildEngagementsForScenario(unit, target, mode, scenario);
      if (engagements.length === 0) continue;
      const summary = runUnitPhaseSimulation(
        engagements.map((e) => ({ ctx: e.ctx, rerolls: e.rerolls })),
        { label: `${unit.name} — ${label}`, iterations }
      );
      const option: RankedOption = {
        unitId: unit.id,
        unitName: unit.name,
        unitPoints: unit.points,
        mode,
        scenarioLabel: label,
        summary,
        // Raw per-weapon breakdown: same weapon/rerolls, but fired at an
        // uncapped-wounds clone of the target so overkill never eats into
        // the figures (see `uncapTargetWounds` above) — this is "what does
        // this weapon roll," not "what does it get to keep."
        damageByWeapon: engagements.map((e) => {
          const breakdown = runWeaponBreakdown({ ...e.ctx, target: uncappedTarget }, {
            label: e.weaponLabel,
            iterations: Math.min(iterations, SOLO_WEAPON_ITERATIONS),
            rerolls: e.rerolls,
          });
          return {
            label: e.weaponLabel,
            attacks: breakdown.meanAttacks,
            hits: breakdown.meanHits,
            woundsDealt: breakdown.meanWoundsDealt,
            unsavedWounds: breakdown.meanUnsavedWounds,
            avg: breakdown.meanDamage,
          };
        }),
      };
      results.push(option);

      const existing = bestPerUnit.get(unit.id);
      const isBetter =
        !existing ||
        summary.killProbability > existing.option.summary.killProbability ||
        (summary.killProbability === existing.option.summary.killProbability &&
          summary.meanDamage > existing.option.summary.meanDamage);
      if (isBetter) {
        bestPerUnit.set(unit.id, { unit, mode, scenario, label, option });
      }
    }
  }

  const combinations = computeCombinations(target, [...bestPerUnit.values()], comboIterations);

  return { singles: sortOptions(results, "kill"), combinations: sortCombinations(combinations) };
}

function computeCombinations(
  target: TargetUnit,
  bestPerUnit: BestPerUnit[],
  comboIterations: number
): CombinationOption[] {
  const candidates = [...bestPerUnit]
    .sort((a, b) => b.option.summary.meanDamage - a.option.summary.meanDamage)
    .slice(0, COMBO_CANDIDATE_POOL_SIZE);

  const combos: BestPerUnit[][] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      combos.push([candidates[i], candidates[j]]);
      for (let k = j + 1; k < candidates.length; k++) {
        combos.push([candidates[i], candidates[j], candidates[k]]);
      }
    }
  }

  const results: CombinationOption[] = [];
  for (const combo of combos) {
    const engagements = combo.flatMap((member) =>
      buildEngagementsForScenario(member.unit, target, member.mode, member.scenario)
    );
    if (engagements.length === 0) continue;
    const label = combo.map((m) => m.unit.name).join(" + ");
    const summary = runUnitPhaseSimulation(
      engagements.map((e) => ({ ctx: e.ctx, rerolls: e.rerolls })),
      { label, iterations: comboIterations }
    );
    results.push({
      unitIds: combo.map((m) => m.unit.id),
      unitNames: combo.map((m) => m.unit.name),
      totalPoints: combo.reduce((sum, m) => sum + m.unit.points, 0),
      memberLabels: combo.map((m) => `${m.unit.name} (${m.mode === "shooting" ? "Shooting" : "Melee"} — ${m.label})`),
      summary,
    });
  }
  return results;
}

export function sortOptions(options: RankedOption[], key: SortKey): RankedOption[] {
  const sorted = [...options];
  sorted.sort((a, b) => {
    if (key === "kill") {
      if (b.summary.killProbability !== a.summary.killProbability) {
        return b.summary.killProbability - a.summary.killProbability;
      }
      return b.summary.meanDamage - a.summary.meanDamage;
    }
    if (key === "avgDamage") {
      return b.summary.meanDamage - a.summary.meanDamage;
    }
    // damagePerPoint
    const aRatio = a.summary.meanDamage / a.unitPoints;
    const bRatio = b.summary.meanDamage / b.unitPoints;
    return bRatio - aRatio;
  });
  return sorted;
}

/** Combinations are ranked to answer "smallest/cheapest group that reliably kills this":
 * fewer units first, then higher kill probability, then fewer points spent. */
export function sortCombinations(options: CombinationOption[]): CombinationOption[] {
  const sorted = [...options];
  sorted.sort((a, b) => {
    if (a.unitIds.length !== b.unitIds.length) return a.unitIds.length - b.unitIds.length;
    if (b.summary.killProbability !== a.summary.killProbability) {
      return b.summary.killProbability - a.summary.killProbability;
    }
    return a.totalPoints - b.totalPoints;
  });
  return sorted;
}
