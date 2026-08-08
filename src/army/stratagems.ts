/**
 * Stratagem text. BattleScribe/BSData catalogue files do NOT carry stratagem card
 * text (stratagems don't affect list-building legality, so they're omitted from
 * that data source). Provenance per stratagem:
 *
 * - Truesilver Channelling, Purgation Pattern: found verbatim in Wahapedia's
 *   10th-edition CSV mirror under the real "Brotherhood Strike" detachment,
 *   which is independently confirmed (via Fury of Titan / enhancements) to
 *   carry over unchanged into 11e. Moderate-high confidence.
 * - Focused Immolation, Spiritsear, Soul-Locked (Fires of Purgation detachment):
 *   NOT found in any live source checked (Wahapedia 10e doesn't have this
 *   detachment at all — it's 11e-only, and BSData doesn't carry stratagem text).
 *   Sourced from the user-supplied build spec only — unverified against a live
 *   source. Flag to the user if exact wording ever needs to be double-checked
 *   against the physical/app rules.
 * - Core stratagems: standard, low-risk-of-drift text.
 */

export interface Stratagem {
  name: string;
  cpCost: number;
  scope: "core" | "Brotherhood Strike" | "Fires of Purgation";
  phase: string;
  description: string;
  damageEffect?: StratagemDamageEffect;
  verified: "wahapedia-10e-mirror" | "unverified-user-supplied" | "standard-core";
}

export type StratagemDamageEffect =
  | { kind: "grant-devastating-wounds"; appliesTo: "psychic-melee" | "purgation-squad-shooting" }
  | { kind: "grant-sustained-hits"; value: number; appliesTo: "purgation-squad-shooting" }
  | { kind: "mortal-wounds-on-battleshocked"; value: { dice: "D3"; flat: number } };

export const STRATAGEMS: Stratagem[] = [
  {
    name: "Truesilver Channelling",
    cpCost: 2,
    scope: "Brotherhood Strike",
    phase: "Fight phase",
    description:
      "TARGET: One Grey Knights Infantry unit from your army that has not been selected to fight this phase. EFFECT: Until the end of the phase, Psychic weapons equipped by models in your unit have the [DEVASTATING WOUNDS] ability.",
    damageEffect: { kind: "grant-devastating-wounds", appliesTo: "psychic-melee" },
    verified: "wahapedia-10e-mirror",
  },
  {
    name: "Purgation Pattern",
    cpCost: 1,
    scope: "Brotherhood Strike",
    phase: "Shooting phase",
    description:
      "TARGET: One Grey Knights unit that was set up using the Deep Strike ability this turn and has not been selected to shoot this phase. EFFECT: Until the end of the phase, weapons equipped by models in your unit have the [SUSTAINED HITS 1] ability.",
    damageEffect: { kind: "grant-sustained-hits", value: 1, appliesTo: "purgation-squad-shooting" },
    verified: "wahapedia-10e-mirror",
  },
  {
    name: "Focused Immolation",
    cpCost: 1,
    scope: "Fires of Purgation",
    phase: "Shooting phase",
    description:
      "After a PURGATION SQUAD unit has shot, target one thing it hit: that target's attacks gain [DEVASTATING WOUNDS] and [SUSTAINED HITS 1].",
    damageEffect: { kind: "grant-devastating-wounds", appliesTo: "purgation-squad-shooting" },
    verified: "unverified-user-supplied",
  },
  {
    name: "Spiritsear",
    cpCost: 1,
    scope: "Fires of Purgation",
    phase: "Shooting phase",
    description:
      "After a Purgation Squad shot, target a battle-shocked enemy it hit: that unit suffers D3+1 mortal wounds.",
    damageEffect: { kind: "mortal-wounds-on-battleshocked", value: { dice: "D3", flat: 1 } },
    verified: "unverified-user-supplied",
  },
  {
    name: "Command Re-roll",
    cpCost: 1,
    scope: "core",
    phase: "Any phase",
    description: "Re-roll a Hit, Wound, Damage, Advance, Charge, Hazard, or Save roll.",
    verified: "standard-core",
  },
];

export function findStratagem(name: string): Stratagem | undefined {
  return STRATAGEMS.find((s) => s.name === name);
}
