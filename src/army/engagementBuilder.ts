import type { AttackContext, TargetUnit, WeaponProfile } from "../engine/types";
import type { RerollFlags } from "../engine/attackSequence";
import { WEAPONS } from "./weapons";
import type { UnitDefinition } from "./roster";
import { ENHANCEMENTS } from "./detachments";

export interface ScenarioFlags {
  halfRange: boolean;
  /** Truesilver Channelling (melee, psychic) or Focused Immolation (Purgation Squad shooting). */
  stratagemBoost: boolean;
  /** Fury of Titan — this unit deep struck this turn (free, always-on re-rolls, not a CP toggle). */
  deepStruck: boolean;
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

/** Build one AttackContext per distinct ranged weapon across a unit's loadouts, for a shooting-phase scenario. */
export function buildShootingEngagements(
  unit: UnitDefinition,
  target: TargetUnit,
  scenario: ScenarioFlags
): WeaponEngagement[] {
  const engagements: WeaponEngagement[] = [];
  const strengthBonus = enhancementStrengthBonus(unit);
  const rerolls: RerollFlags | undefined = scenario.deepStruck
    ? { hitRerollOnes: true, woundRerollOnes: true }
    : undefined;

  for (const loadout of unit.loadouts) {
    for (const weaponKey of loadout.rangedWeapons) {
      const weapon = WEAPONS[weaponKey];
      if (!weapon) continue;
      const grantDevastatingWounds = scenario.stratagemBoost && !!unit.isPurgationSquad;
      const bonusSustainedHits = scenario.stratagemBoost && unit.isPurgationSquad ? 1 : undefined;
      const ctx: AttackContext = {
        numAttackingModels: loadout.count,
        weapon,
        target,
        halfRange: scenario.halfRange,
        hitMod: 0,
        woundMod: 0,
        strengthBonus,
        bonusSustainedHits,
        grantDevastatingWounds,
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
  const rerolls: RerollFlags | undefined = scenario.deepStruck
    ? { hitRerollOnes: true, woundRerollOnes: true }
    : undefined;

  for (const loadout of unit.loadouts) {
    if (!loadout.meleeWeapon) continue;
    const weapon = WEAPONS[loadout.meleeWeapon];
    if (!weapon) continue;
    // Truesilver Channelling: Devastating Wounds for PSYCHIC weapons in a GK Infantry unit fighting.
    const grantDevastatingWounds = scenario.stratagemBoost && !!weapon.isPsychic;
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

export function unitScenarios(unit: UnitDefinition): {
  mode: "shooting" | "melee";
  scenario: ScenarioFlags;
  label: string;
}[] {
  const scenarios: { mode: "shooting" | "melee"; scenario: ScenarioFlags; label: string }[] = [];
  const rangeSensitive = unitHasRangeSensitiveWeapon(unit);
  const hasRanged = unit.loadouts.some((l) => l.rangedWeapons.length > 0);
  const hasMelee = unit.loadouts.some((l) => l.meleeWeapon);
  const hasPsychicMelee = unitHasPsychicMelee(unit);

  if (hasRanged) {
    const ranges = rangeSensitive ? [true, false] : [false];
    for (const halfRange of ranges) {
      const rangeLabel = rangeSensitive ? (halfRange ? "half range" : "full range") : "shooting";
      scenarios.push({
        mode: "shooting",
        scenario: { halfRange, stratagemBoost: false, deepStruck: false },
        label: rangeLabel,
      });
      if (unit.isPurgationSquad) {
        scenarios.push({
          mode: "shooting",
          scenario: { halfRange, stratagemBoost: true, deepStruck: false },
          label: `${rangeLabel}, Focused Immolation (1CP)`,
        });
      }
    }
  }
  if (hasMelee) {
    scenarios.push({ mode: "melee", scenario: { halfRange: false, stratagemBoost: false, deepStruck: false }, label: "melee" });
    if (hasPsychicMelee) {
      scenarios.push({
        mode: "melee",
        scenario: { halfRange: false, stratagemBoost: true, deepStruck: false },
        label: "melee, Truesilver Channelling (2CP)",
      });
    }
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
