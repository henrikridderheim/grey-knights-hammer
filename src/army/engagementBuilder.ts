import type { AttackContext, TargetUnit, WeaponProfile } from "../engine/types";
import type { RerollFlags } from "../engine/attackSequence";
import { WEAPONS } from "./weapons";
import type { UnitDefinition } from "./roster";
import { ENHANCEMENTS } from "./detachments";

/**
 * User-controlled toggles for every damage-affecting rule/stratagem this army
 * has, applied uniformly wherever they're eligible (rather than the engine
 * silently guessing whether they're "on"). All default off — the base
 * scenario reflects no CP spent and no deep strike this turn.
 */
export interface DamageSettings {
  /** Brotherhood Strike detachment rule (free, not a stratagem): re-roll Hit
   * roll of 1 and Wound roll of 1 for a unit that deep struck this turn. */
  furyOfTitan: boolean;
  /** 1CP. Any Grey Knights unit that deep struck this turn and hasn't shot
   * yet: its weapons gain [SUSTAINED HITS 1]. */
  purgationPattern: boolean;
  /** 2CP. A Grey Knights Infantry unit fighting: its Psychic melee weapons
   * gain [DEVASTATING WOUNDS]. */
  truesilverChannelling: boolean;
  /** 1CP, Purgation Squad only. After it's shot, one hit target's attacks
   * gain [DEVASTATING WOUNDS] and [SUSTAINED HITS 1]. */
  focusedImmolation: boolean;
  /** Purifier Squad's Sanctity of Purpose ability upgrade: re-roll ANY failed
   * Wound roll (not just a 1) when the target is within range of an
   * objective marker. The plain re-roll-a-1 part of that ability is always
   * on regardless of this toggle. */
  nearObjective: boolean;
}

export const DEFAULT_DAMAGE_SETTINGS: DamageSettings = {
  furyOfTitan: false,
  purgationPattern: false,
  truesilverChannelling: false,
  focusedImmolation: false,
  nearObjective: false,
};

export interface ScenarioFlags {
  halfRange: boolean;
  deepStruck: boolean; // Fury of Titan re-rolls
  purgationPatternActive: boolean; // +[SUSTAINED HITS 1], any unit shooting
  focusedImmolationActive: boolean; // Purgation Squad shooting: +Devastating Wounds, +Sustained Hits 1
  truesilverChannellingActive: boolean; // psychic melee: +Devastating Wounds
  nearObjective: boolean; // Sanctity of Purpose upgrade (Purifier Squad)
}

export interface WeaponEngagement {
  weaponLabel: string;
  ctx: AttackContext;
  rerolls?: RerollFlags;
}

function enhancementStrengthBonus(unit: UnitDefinition): number {
  const enh = ENHANCEMENTS.find((e) => e.name === unit.enhancement);
  return enh?.damageEffect?.kind === "strength-bonus" ? enh.damageEffect.value : 0;
}

function unitHasRangeSensitiveWeapon(unit: UnitDefinition): boolean {
  return unit.loadouts.some((l) =>
    l.rangedWeapons.some((key) => {
      const w = WEAPONS[key];
      return !!(w?.keywords.rapidFire || w?.keywords.melta);
    })
  );
}

function unitHasPsychicMelee(unit: UnitDefinition): boolean {
  return unit.loadouts.some((l) => {
    const w = l.meleeWeapon ? WEAPONS[l.meleeWeapon] : undefined;
    return !!w?.isPsychic;
  });
}

function furyOfTitanRerolls(scenario: ScenarioFlags): RerollFlags | undefined {
  return scenario.deepStruck ? { hitRerollOnes: true, woundRerollOnes: true } : undefined;
}

/** Build one AttackContext per distinct ranged weapon across a unit's loadouts, for a shooting-phase scenario. */
export function buildShootingEngagements(
  unit: UnitDefinition,
  target: TargetUnit,
  scenario: ScenarioFlags
): WeaponEngagement[] {
  const engagements: WeaponEngagement[] = [];
  const strengthBonus = enhancementStrengthBonus(unit);
  const baseRerolls = furyOfTitanRerolls(scenario);
  // Sanctity of Purpose (Purifier Squad only): re-roll a Wound roll of 1 is
  // always on; upgrades to re-roll any failed Wound roll near an objective.
  const rerolls: RerollFlags | undefined = unit.hasSanctityOfPurpose
    ? {
        ...baseRerolls,
        woundRerollOnes: true,
        woundRerollAllFailed: scenario.nearObjective || undefined,
      }
    : baseRerolls;

  const focusedImmolationEligible = scenario.focusedImmolationActive && !!unit.isPurgationSquad;
  const bonusSustainedHits =
    (scenario.purgationPatternActive ? 1 : 0) + (focusedImmolationEligible ? 1 : 0);

  for (const loadout of unit.loadouts) {
    for (const weaponKey of loadout.rangedWeapons) {
      const weapon = WEAPONS[weaponKey];
      if (!weapon) continue;
      const ctx: AttackContext = {
        numAttackingModels: loadout.count,
        weapon,
        target,
        halfRange: scenario.halfRange,
        hitMod: 0,
        woundMod: 0,
        strengthBonus,
        bonusSustainedHits: bonusSustainedHits > 0 ? bonusSustainedHits : undefined,
        grantDevastatingWounds: focusedImmolationEligible,
      };
      engagements.push({ weaponLabel: `${weapon.name} (${loadout.label})`, ctx, rerolls });
    }
  }
  return engagements;
}

/** Build one AttackContext for a unit's melee weapon(s), for a fight-phase scenario. */
export function buildMeleeEngagements(
  unit: UnitDefinition,
  target: TargetUnit,
  scenario: ScenarioFlags
): WeaponEngagement[] {
  const engagements: WeaponEngagement[] = [];
  const rerolls = furyOfTitanRerolls(scenario);

  for (const loadout of unit.loadouts) {
    if (!loadout.meleeWeapon) continue;
    const weapon = WEAPONS[loadout.meleeWeapon];
    if (!weapon) continue;
    // Truesilver Channelling: Devastating Wounds for PSYCHIC weapons in a GK Infantry unit fighting.
    const grantDevastatingWounds = scenario.truesilverChannellingActive && !!weapon.isPsychic;
    const ctx: AttackContext = {
      numAttackingModels: loadout.count,
      weapon,
      target,
      halfRange: false,
      hitMod: 0,
      woundMod: 0,
      strengthBonus: 0,
      grantDevastatingWounds,
    };
    engagements.push({ weaponLabel: `${weapon.name} (${loadout.label})`, ctx, rerolls });
  }
  return engagements;
}

function scenarioLabel(base: string, unit: UnitDefinition, scenario: ScenarioFlags, mode: "shooting" | "melee"): string {
  const parts = [base];
  if (scenario.deepStruck) parts.push("Fury of Titan");
  if (mode === "shooting") {
    if (scenario.purgationPatternActive) parts.push("Purgation Pattern (1CP)");
    if (scenario.focusedImmolationActive && unit.isPurgationSquad) parts.push("Focused Immolation (1CP)");
  } else {
    if (scenario.truesilverChannellingActive && unitHasPsychicMelee(unit)) parts.push("Truesilver Channelling (2CP)");
  }
  if (unit.hasSanctityOfPurpose && scenario.nearObjective) parts.push("near objective");
  return parts.join(", ");
}

/** One scenario per range-band (shooting) / one for melee, reflecting the
 * current global `settings` toggles — not an auto-generated matrix of every
 * combination. Toggle the settings and re-run to compare "with" vs "without"
 * any given rule directly. */
export function unitScenarios(
  unit: UnitDefinition,
  settings: DamageSettings
): { mode: "shooting" | "melee"; scenario: ScenarioFlags; label: string }[] {
  const scenarios: { mode: "shooting" | "melee"; scenario: ScenarioFlags; label: string }[] = [];
  const rangeSensitive = unitHasRangeSensitiveWeapon(unit);
  const hasRanged = unit.loadouts.some((l) => l.rangedWeapons.length > 0);
  const hasMelee = unit.loadouts.some((l) => l.meleeWeapon);

  if (hasRanged) {
    const ranges = rangeSensitive ? [true, false] : [false];
    for (const halfRange of ranges) {
      const rangeLabel = rangeSensitive ? (halfRange ? "half range" : "full range") : "shooting";
      const scenario: ScenarioFlags = {
        halfRange,
        deepStruck: settings.furyOfTitan,
        purgationPatternActive: settings.purgationPattern,
        focusedImmolationActive: settings.focusedImmolation,
        truesilverChannellingActive: false,
        nearObjective: settings.nearObjective,
      };
      scenarios.push({ mode: "shooting", scenario, label: scenarioLabel(rangeLabel, unit, scenario, "shooting") });
    }
  }
  if (hasMelee) {
    const scenario: ScenarioFlags = {
      halfRange: false,
      deepStruck: settings.furyOfTitan,
      purgationPatternActive: false,
      focusedImmolationActive: false,
      truesilverChannellingActive: settings.truesilverChannelling,
      nearObjective: settings.nearObjective,
    };
    scenarios.push({ mode: "melee", scenario, label: scenarioLabel("melee", unit, scenario, "melee") });
  }
  return scenarios;
}

export function buildEngagementsForScenario(
  unit: UnitDefinition,
  target: TargetUnit,
  mode: "shooting" | "melee",
  scenario: ScenarioFlags
): WeaponEngagement[] {
  return mode === "shooting"
    ? buildShootingEngagements(unit, target, scenario)
    : buildMeleeEngagements(unit, target, scenario);
}

export function weaponAverage(weapon: WeaponProfile): number {
  return typeof weapon.damage === "number" ? weapon.damage : (weapon.damage.dice === "D3" ? 2 : 3.5) + (weapon.damage.flat ?? 0);
}
