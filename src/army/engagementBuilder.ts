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

export function unitHasPsychicMelee(unit: UnitDefinition): boolean {
  return unit.loadouts.some((l) => {
    const w = l.meleeWeapon ? WEAPONS[l.meleeWeapon] : undefined;
    return !!w?.isPsychic;
  });
}

/** Which of the 5 stratagems/rules actually apply to this unit — not every
 * one is universal:
 * - Fury of Titan / Purgation Pattern: any Grey Knights unit (no restriction).
 * - Truesilver Channelling: Grey Knights INFANTRY unit with a Psychic melee
 *   weapon (excludes e.g. the Nemesis Dreadknight, which is MONSTER not
 *   INFANTRY even though its greathammer is Psychic).
 * - Focused Immolation: Purgation Squad only.
 * - "near objective" (Sanctity of Purpose upgrade): Purifier Squad only.
 * Used to only show/offer toggles that are actually valid for a given unit,
 * instead of showing every toggle for every unit regardless of eligibility. */
export function eligibleStratagemKeys(unit: UnitDefinition): (keyof DamageSettings)[] {
  const keys: (keyof DamageSettings)[] = ["furyOfTitan", "purgationPattern"];
  if (unit.keywords.includes("INFANTRY") && unitHasPsychicMelee(unit)) keys.push("truesilverChannelling");
  if (unit.isPurgationSquad) keys.push("focusedImmolation");
  if (unit.hasSanctityOfPurpose) keys.push("nearObjective");
  return keys;
}

/** Translate a target's own toggled defensive rules into the AttackContext
 * fields that apply them — same for every weapon/engagement built against
 * that target, in either phase, regardless of which of my units is
 * attacking. */
function defensiveMods(target: TargetUnit): { woundMod: number; apReduction: number; damageReduction: number } {
  const d = target.defensiveSettings;
  const inc = target.incoming;
  return {
    // Manual -1-to-Wound toggle and any auto-detected -1-to-Wound ability stack
    // here (the engine clamps the net wound modifier to the ±1 core-rules cap).
    woundMod: (d?.minusOneToWound ? -1 : 0) - (inc?.woundPenalty ?? 0),
    apReduction: d?.minusOneToAP ? 1 : 0,
    damageReduction: (d?.minusOneToDamage ? 1 : 0) + (inc?.damageReduction ?? 0),
  };
}

/** Target-imposed penalty to incoming Hit rolls (e.g. an auto-detected -1 to
 * Hit / Stealth ability). Cover is handled separately, per-weapon, since it's
 * negated by [IGNORES COVER]. */
function incomingHitMod(target: TargetUnit): number {
  return -(target.incoming?.hitPenalty ?? 0);
}

function furyOfTitanRerolls(scenario: ScenarioFlags): RerollFlags | undefined {
  return scenario.deepStruck ? { hitRerollOnes: true, woundRerollOnes: true } : undefined;
}

/** Fury of Titan (if deep struck) plus Sanctity of Purpose (Purifier Squad
 * only) merged into one reroll set — Sanctity of Purpose is a unit-wide
 * ability, not a shooting-only one, so it must apply to this unit's melee
 * attacks exactly as much as its shooting: re-roll a Wound roll of 1 is
 * always on, upgrading to re-roll any failed Wound roll near an objective.
 * Shared by both `buildShootingEngagements` and `buildMeleeEngagements` so
 * the two phases can never drift out of sync on this. */
function unitRerolls(unit: UnitDefinition, scenario: ScenarioFlags): RerollFlags | undefined {
  const baseRerolls = furyOfTitanRerolls(scenario);
  return unit.hasSanctityOfPurpose
    ? {
        ...baseRerolls,
        woundRerollOnes: true,
        woundRerollAllFailed: scenario.nearObjective || undefined,
      }
    : baseRerolls;
}

/** Build one AttackContext per distinct ranged weapon across a unit's loadouts, for a shooting-phase scenario. */
export function buildShootingEngagements(
  unit: UnitDefinition,
  target: TargetUnit,
  scenario: ScenarioFlags
): WeaponEngagement[] {
  const engagements: WeaponEngagement[] = [];
  const strengthBonus = enhancementStrengthBonus(unit);
  const rerolls = unitRerolls(unit, scenario);
  const { woundMod, apReduction, damageReduction } = defensiveMods(target);

  const focusedImmolationEligible = scenario.focusedImmolationActive && !!unit.isPurgationSquad;
  const bonusSustainedHits =
    (scenario.purgationPatternActive ? 1 : 0) + (focusedImmolationEligible ? 1 : 0);

  for (const loadout of unit.loadouts) {
    for (const weaponKey of loadout.rangedWeapons) {
      const weapon = WEAPONS[weaponKey];
      if (!weapon) continue;
      // Champion of the Order of Purifiers: +1 Attacks to every Purifying
      // Flame weapon in the unit Crowe is leading — including his own.
      const attacksBonus = unit.hasChampionOfPurifiers && weapon.name === "Purifying Flame" ? 1 : undefined;
      // Cover: -1 to the Hit roll of ranged attacks against a target with the
      // benefit of cover, unless the weapon has [IGNORES COVER] — 11e rule
      // (10e instead gave the defender a save bonus; this app targets 11e,
      // so it must be a hit-roll penalty, not a save change). Ranged only —
      // cover doesn't affect melee, so this never applies in
      // `buildMeleeEngagements` below.
      // Cover (-1, negated by [IGNORES COVER]) plus any auto-detected -1-to-Hit
      // ability (e.g. Stealth, which is a ranged-only penalty — hence applied
      // here in the shooting builder, not in melee). Engine clamps the total.
      const hitMod =
        (target.hasCover && !weapon.keywords.ignoresCover ? -1 : 0) + incomingHitMod(target);
      const ctx: AttackContext = {
        numAttackingModels: loadout.count,
        weapon,
        target,
        halfRange: scenario.halfRange,
        hitMod,
        woundMod,
        strengthBonus,
        attacksBonus,
        bonusSustainedHits: bonusSustainedHits > 0 ? bonusSustainedHits : undefined,
        grantDevastatingWounds: focusedImmolationEligible,
        apReduction,
        damageReduction,
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
  const rerolls = unitRerolls(unit, scenario);
  const { woundMod, apReduction, damageReduction } = defensiveMods(target);

  for (const loadout of unit.loadouts) {
    if (!loadout.meleeWeapon) continue;
    const weapon = WEAPONS[loadout.meleeWeapon];
    if (!weapon) continue;
    // Truesilver Channelling: Devastating Wounds for PSYCHIC weapons in a GK
    // Infantry unit fighting — gated on INFANTRY too, not just the weapon
    // being Psychic (e.g. the Dreadknight's greathammer is Psychic, but the
    // Dreadknight itself is MONSTER, not INFANTRY, so it doesn't qualify).
    const grantDevastatingWounds =
      scenario.truesilverChannellingActive && unit.keywords.includes("INFANTRY") && !!weapon.isPsychic;
    const ctx: AttackContext = {
      numAttackingModels: loadout.count,
      weapon,
      target,
      halfRange: false,
      hitMod: 0,
      woundMod,
      strengthBonus: 0,
      grantDevastatingWounds,
      apReduction,
      damageReduction,
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
 * any given rule directly.
 *
 * `halfRangeOverride` controls the shooting range band for range-sensitive
 * (Rapid Fire / Melta) units:
 *   - undefined → auto: enumerate BOTH half-range and full-range scenarios
 *     (the original behaviour — lets a caller compare or auto-pick the best).
 *   - true  → half range only (the bonus is active).
 *   - false → full range only (no bonus).
 * A manual per-calculation half-range toggle in the UI passes true/false here
 * to force a single band instead of the auto pair. Non-range-sensitive units
 * always resolve to a single "shooting" scenario regardless. */
export function unitScenarios(
  unit: UnitDefinition,
  settings: DamageSettings,
  halfRangeOverride?: boolean
): { mode: "shooting" | "melee"; scenario: ScenarioFlags; label: string }[] {
  const scenarios: { mode: "shooting" | "melee"; scenario: ScenarioFlags; label: string }[] = [];
  const rangeSensitive = unitHasRangeSensitiveWeapon(unit);
  const hasRanged = unit.loadouts.some((l) => l.rangedWeapons.length > 0);
  const hasMelee = unit.loadouts.some((l) => l.meleeWeapon);

  if (hasRanged) {
    const ranges =
      halfRangeOverride === undefined
        ? rangeSensitive
          ? [true, false]
          : [false]
        : [rangeSensitive ? halfRangeOverride : false];
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
