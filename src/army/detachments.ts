/**
 * Detachment rules and enhancements for "Pure Purge" (Brotherhood Strike + Fires of Purgation).
 * Verified against BSData/wh40k-11e "Imperium - Grey Knights.json" (live-fetched 2026-08-08),
 * a community-maintained but currently-accurate 11th-edition data source — Wahapedia's public
 * CSV export is still on 10th edition as of this date, so it was not usable as the source here.
 */

export interface DetachmentAbility {
  name: string;
  detachment: "Brotherhood Strike" | "Fires of Purgation";
  description: string;
  /** Whether this ability directly changes damage-math (vs. purely positional/utility). */
  damageRelevant: boolean;
}

export const DETACHMENT_ABILITIES: DetachmentAbility[] = [
  {
    name: "Fury of Titan",
    detachment: "Brotherhood Strike",
    description:
      "Each time a unit from your army is set up using the Deep Strike ability, until the end of the turn, each time a model in that unit makes an attack, re-roll a Hit roll of 1 and re-roll a Wound roll of 1.",
    damageRelevant: true,
  },
  {
    name: "Searing Soulflame",
    detachment: "Fires of Purgation",
    description:
      "When you select a unit to be pinned by a friendly PURGATION SQUAD unit's Righteous Persecution ability, that enemy unit makes a battle-shock roll, with -1 to that battle-shock roll.",
    damageRelevant: false, // battle-shock manipulation, not a direct damage modifier
  },
];

export interface Enhancement {
  name: string;
  detachment: "Brotherhood Strike" | "Fires of Purgation";
  points: number;
  description: string;
  damageEffect?: {
    kind: "strength-bonus";
    value: number;
  };
}

export const ENHANCEMENTS: Enhancement[] = [
  {
    name: "Purity of Purpose",
    detachment: "Brotherhood Strike",
    points: 15,
    description:
      "GREY KNIGHTS model only. Each time the bearer's unit is set up using the Deep Strike ability, until the end of the turn, you can re-roll Charge rolls made for the bearer's unit.",
  },
  {
    name: "Tome of Forbidden Ways",
    detachment: "Brotherhood Strike",
    points: 25,
    description:
      "GREY KNIGHTS model only. While the bearer is on the battlefield or in Strategic Reserves, add 1 to the number of units from your army that you can select for the Gate of Infinity rule.",
  },
  {
    name: "Boons of Deimos",
    detachment: "Fires of Purgation",
    points: 20,
    description: "This unit's ranged attacks have +2 S.",
    damageEffect: { kind: "strength-bonus", value: 2 },
  },
];
