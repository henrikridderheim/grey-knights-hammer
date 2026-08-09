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

/** Combines a base scenario label with the deep-struck (Fury of Titan) and
 * stratagem-boost labels that apply to it, if any. */
function withModifierLabels(base: string, deepStruck: boolean, stratagemLabel: string | null): string {
  const parts = [base];
  if (deepStruck) parts.push("Fury of Titan (deep struck)");
  if (stratagemLabel) parts.push(stratagemLabel);
  return parts.join(", ");
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
  // All Grey Knights units in this army have the Deep Strike ability (verified
  // against BSData), so Fury of Titan — the Brotherhood Strike detachment's
  // free re-roll of Hit/Wound rolls of 1 on the turn a unit deep strikes — is
  // modeled as an available toggle for every unit, not just a labeled-but-
  // never-generated scenario.
  const deepStrikeOptions = [false, true];

  if (hasRanged) {
    const ranges = rangeSensitive ? [true, false] : [false];
    for (const halfRange of ranges) {
      const rangeLabel = rangeSensitive ? (halfRange ? "half range" : "full range") : "shooting";
      const stratagemLabels = unit.isPurgationSquad
        ? [null, "Focused Immolation (1CP)"]
        : [null];
      for (const deepStruck of deepStrikeOptions) {
        for (const stratagemLabel of stratagemLabels) {
          scenarios.push({
            mode: "shooting",
            scenario: { halfRange, stratagemBoost: !!stratagemLabel, deepStruck },
            label: withModifierLabels(rangeLabel, deepStruck, stratagemLabel),
          });
        }
      }
    }
  }
  if (hasMelee) {
    const stratagemLabels = hasPsychicMelee ? [null, "Truesilver Channelling (2CP)"] : [null];
    for (const deepStruck of deepStrikeOptions) {
      for (const stratagemLabel of stratagemLabels) {
        scenarios.push({
          mode: "melee",
          scenario: { halfRange: false, stratagemBoost: !!stratagemLabel, deepStruck },
          label: withModifierLabels("melee", deepStruck, stratagemLabel),
        });
      }
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
