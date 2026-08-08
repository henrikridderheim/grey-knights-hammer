import type { TargetUnit } from "../engine/types";
import { runUnitPhaseSimulation } from "../engine/simulate";
import { ROSTER, type UnitDefinition } from "./roster";
import { buildEngagementsForScenario, unitScenarios } from "./engagementBuilder";
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

const DEFAULT_ITERATIONS = 1500;

export function computeBestWayToKillIt(
  target: TargetUnit,
  options: { iterations?: number } = {}
): RankedOption[] {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const results: RankedOption[] = [];

  for (const unit of ROSTER as UnitDefinition[]) {
    for (const { mode, scenario, label } of unitScenarios(unit)) {
      const engagements = buildEngagementsForScenario(unit, target, mode, scenario);
      if (engagements.length === 0) continue;
      const summary = runUnitPhaseSimulation(
        engagements.map((e) => ({ ctx: e.ctx, rerolls: e.rerolls })),
        { label: `${unit.name} — ${label}`, iterations }
      );
      results.push({
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
      });
    }
  }

  return sortOptions(results, "kill");
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
