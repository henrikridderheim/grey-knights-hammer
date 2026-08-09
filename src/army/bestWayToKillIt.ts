import type { TargetUnit } from "../engine/types";
import { runUnitPhaseSimulation } from "../engine/simulate";
import { ROSTER, type UnitDefinition } from "./roster";
import { buildEngagementsForScenario, unitScenarios, type ScenarioFlags } from "./engagementBuilder";
import type { SimulationSummary } from "../engine/types";

export type SortKey = "kill" | "avgDamage" | "damagePerPoint";

export interface RankedOption {
  unitId: string;
  unitName: string;
  unitPoints: number;
  mode: "shooting" | "melee";
  scenarioLabel: string;
  summary: SimulationSummary;
  damageByWeapon: { label: string; avg: number }[];
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
  options: { iterations?: number; comboIterations?: number } = {}
): BestWayToKillItResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const comboIterations = options.comboIterations ?? COMBO_ITERATIONS;
  const results: RankedOption[] = [];
  const bestPerUnit = new Map<string, BestPerUnit>();

  for (const unit of ROSTER as UnitDefinition[]) {
    for (const { mode, scenario, label } of unitScenarios(unit)) {
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
        damageByWeapon: engagements.map((e, i) => ({
          label: e.weaponLabel,
          avg: summary.meanDamageByWeapon[i] ?? 0,
        })),
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
