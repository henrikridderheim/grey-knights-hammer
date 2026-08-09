/**
 * "Pure Purge" — hardcoded default Grey Knights roster, 2000pts, Strike Force.
 * Detachment: Brotherhood Strike + Fires of Purgation (combined, 3 Detachment Points).
 * Source: user-supplied army export, cross-checked against BSData/wh40k-11e —
 * see scripts/verification-report.md for the full reconciliation.
 *
 * One open item from that report: the three Grand Master in Nemesis Dreadknight
 * costs (255/245/245) don't cleanly reproduce from the catalogue's base+wargear
 * costs (230pts/model) plus its repeat-copy surcharge without knowing exact
 * roster order/enhancement assignment. Wargear/statline/abilities are fully
 * verified regardless; only the points split across the 3 copies is unconfirmed.
 * Worth re-checking in an actual list-builder (NewRecruit/BattleScribe) if the
 * exact per-copy cost ever matters (it doesn't affect the damage-math itself).
 */

export interface Statline {
  move: string;
  toughness: number;
  save: number;
  invulnSave?: number;
  wounds: number;
  leadership: string;
  oc: number;
}

export interface ModelLoadout {
  label: string;
  count: number;
  meleeWeapon?: string; // key into WEAPONS
  rangedWeapons: string[]; // keys into WEAPONS
}

export interface UnitDefinition {
  id: string;
  name: string;
  points: number;
  composition: string;
  statline: Statline;
  loadouts: ModelLoadout[];
  abilities: string[];
  keywords: string[];
  leaderCanAttachTo?: string; // unit id
  enhancement?: string; // Enhancement name from detachments.ts
  isPurgationSquad?: boolean;
}

export const ROSTER: UnitDefinition[] = [
  {
    id: "crowe",
    name: "Castellan Crowe",
    points: 100,
    composition: "1 model",
    statline: { move: "6\"", toughness: 4, save: 2, invulnSave: 4, wounds: 5, leadership: "6+", oc: 1 },
    loadouts: [
      {
        label: "Crowe",
        count: 1,
        meleeWeapon: "Black Blade of Antwyr",
        rangedWeapons: ["Purifying Flame (Crowe)", "Storm bolter (Crowe)"],
      },
    ],
    abilities: [
      "Champion of the Order of Purifiers [PSYCHIC]: while leading a unit, +1 Attacks to Purifying Flame weapons in that unit.",
      "Foesight [PSYCHIC]: re-roll Hit rolls when targeting a CHARACTER. (Named 'Foesight' in the source data, not 'Foresight' — verified spelling.)",
    ],
    keywords: ["INFANTRY", "CHARACTER", "PSYKER", "LEADER"],
    leaderCanAttachTo: "purifier-squad",
  },
  {
    id: "purifier-squad",
    name: "Purifier Squad",
    points: 280,
    composition: "10 models: 1 Knight of the Flame + 9 Purifiers",
    statline: { move: "6\"", toughness: 4, save: 2, wounds: 2, leadership: "6+", oc: 1 },
    loadouts: [
      {
        label: "Knight of the Flame + 5 Purifiers (force weapon)",
        count: 6,
        meleeWeapon: "Nemesis force weapon",
        rangedWeapons: ["Purifying Flame", "Storm bolter"],
      },
      {
        label: "4 Purifiers (psycannon)",
        count: 4,
        meleeWeapon: "Close combat weapon",
        rangedWeapons: ["Purifying Flame", "Psycannon"],
      },
    ],
    abilities: [
      "Sanctity of Purpose: re-roll a Wound roll of 1 (any target); re-roll any failed Wound roll instead if target is within range of an objective marker.",
    ],
    keywords: ["INFANTRY", "PSYKER"],
  },
  {
    id: "gmnd-1",
    name: "Grand Master in Nemesis Dreadknight (Warlord)",
    points: 255,
    composition: "1 model",
    statline: { move: "8\"", toughness: 8, save: 2, invulnSave: 4, wounds: 13, leadership: "6+", oc: 4 },
    loadouts: [
      {
        label: "GMND",
        count: 1,
        meleeWeapon: "Nemesis daemon greathammer",
        rangedWeapons: ["Fragstorm grenade launcher", "Heavy psycannon", "Sublimator"],
      },
    ],
    abilities: [
      "Surge of Wrath [PSYCHIC]: vs. MONSTER/VEHICLE melee attacks, re-roll Hit, Wound, and Damage rolls.",
      "Warrior Strategist: once/battle-round, reduce a Stratagem CP cost targeting this unit by 1.",
      "Damaged (≤4 wounds remaining): -1 to Hit rolls.",
    ],
    keywords: ["MONSTER", "CHARACTER", "PSYKER", "WARLORD"],
    enhancement: "Tome of Forbidden Ways",
  },
  {
    id: "gmnd-2",
    name: "Grand Master in Nemesis Dreadknight",
    points: 245,
    composition: "1 model",
    statline: { move: "8\"", toughness: 8, save: 2, invulnSave: 4, wounds: 13, leadership: "6+", oc: 4 },
    loadouts: [
      {
        label: "GMND",
        count: 1,
        meleeWeapon: "Nemesis daemon greathammer",
        rangedWeapons: ["Fragstorm grenade launcher", "Heavy psycannon", "Sublimator"],
      },
    ],
    abilities: [
      "Surge of Wrath [PSYCHIC]: vs. MONSTER/VEHICLE melee attacks, re-roll Hit, Wound, and Damage rolls.",
      "Warrior Strategist: once/battle-round, reduce a Stratagem CP cost targeting this unit by 1.",
      "Damaged (≤4 wounds remaining): -1 to Hit rolls.",
    ],
    keywords: ["MONSTER", "CHARACTER", "PSYKER"],
    enhancement: "Purity of Purpose",
  },
  {
    id: "gmnd-3",
    name: "Grand Master in Nemesis Dreadknight",
    points: 245,
    composition: "1 model",
    statline: { move: "8\"", toughness: 8, save: 2, invulnSave: 4, wounds: 13, leadership: "6+", oc: 4 },
    loadouts: [
      {
        label: "GMND",
        count: 1,
        meleeWeapon: "Nemesis daemon greathammer",
        rangedWeapons: ["Fragstorm grenade launcher", "Heavy psycannon", "Sublimator"],
      },
    ],
    abilities: [
      "Surge of Wrath [PSYCHIC]: vs. MONSTER/VEHICLE melee attacks, re-roll Hit, Wound, and Damage rolls.",
      "Warrior Strategist: once/battle-round, reduce a Stratagem CP cost targeting this unit by 1.",
      "Damaged (≤4 wounds remaining): -1 to Hit rolls.",
    ],
    keywords: ["MONSTER", "CHARACTER", "PSYKER"],
  },
  {
    id: "terminator-squad",
    name: "Brotherhood Terminator Squad",
    points: 140,
    composition: "4 models: Justicar, 2x Terminator, Ancient",
    statline: { move: "5\"", toughness: 5, save: 2, invulnSave: 4, wounds: 3, leadership: "6+", oc: 2 },
    loadouts: [
      {
        label: "Justicar",
        count: 1,
        meleeWeapon: "Nemesis force weapon (Terminator)",
        rangedWeapons: ["Storm bolter"],
      },
      {
        label: "Terminator (storm bolter)",
        count: 1,
        meleeWeapon: "Nemesis force weapon (Terminator)",
        rangedWeapons: ["Storm bolter"],
      },
      {
        // Per the actual army list export: only 1 of the 2 Terminators carries
        // a Storm bolter — the other's ranged slot is replaced by the
        // Apothecary's Narthecium (a support item, not a weapon), so this
        // model has no ranged attack.
        label: "Terminator (Apothecary's Narthecium)",
        count: 1,
        meleeWeapon: "Nemesis force weapon (Terminator)",
        rangedWeapons: [],
      },
      {
        label: "Ancient",
        count: 1,
        meleeWeapon: "Nemesis force weapon (Terminator)",
        rangedWeapons: ["Incinerator"],
      },
    ],
    abilities: [
      "Ancient's Banner: +1 OC to models in the unit.",
      "Apothecary's Narthecium: in your Command phase, if the bearer lives, return one destroyed non-CHARACTER model to the unit (model-return/revive, not Feel No Pain).",
      "Force Edge [PSYCHIC]: melee attacks vs. non-MONSTER/VEHICLE targets get +1 AP.",
    ],
    keywords: ["INFANTRY", "TERMINATOR", "BATTLELINE", "PSYKER"],
  },
  {
    id: "strike-squad-1",
    name: "Strike Squad",
    points: 115,
    composition: "5 models: Justicar + 4 Grey Knight",
    statline: { move: "6\"", toughness: 4, save: 2, wounds: 2, leadership: "6+", oc: 2 },
    loadouts: [
      { label: "All models", count: 5, meleeWeapon: "Nemesis force weapon", rangedWeapons: ["Storm bolter"] },
    ],
    abilities: ["Sanctifying Ritual (objective control, not damage-relevant). Deep Strike, Scouts 6\"."],
    keywords: ["INFANTRY", "BATTLELINE", "PSYKER"],
  },
  {
    id: "strike-squad-2",
    name: "Strike Squad",
    points: 115,
    composition: "5 models: Justicar + 4 Grey Knight",
    statline: { move: "6\"", toughness: 4, save: 2, wounds: 2, leadership: "6+", oc: 2 },
    loadouts: [
      { label: "All models", count: 5, meleeWeapon: "Nemesis force weapon", rangedWeapons: ["Storm bolter"] },
    ],
    abilities: ["Sanctifying Ritual (objective control, not damage-relevant). Deep Strike, Scouts 6\"."],
    keywords: ["INFANTRY", "BATTLELINE", "PSYKER"],
  },
  {
    id: "purgation-squad-a",
    name: "Purgation 10",
    points: 240,
    composition: "10 models: Purgator Justicar + 9 Purgator",
    statline: { move: "6\"", toughness: 4, save: 2, wounds: 2, leadership: "6+", oc: 1 },
    loadouts: [
      {
        label: "Justicar + 5 Purgator (force weapon)",
        count: 6,
        meleeWeapon: "Nemesis force weapon",
        rangedWeapons: ["Storm bolter"],
      },
      {
        // Per the actual army list export: this squad's close-combat-weapon
        // Purgators carry Psilencer, not Psycannon (the original build spec
        // had this wrong — Psilencer is correct here per the current list).
        label: "4 Purgator (psilencer)",
        count: 4,
        meleeWeapon: "Close combat weapon",
        rangedWeapons: ["Psilencer"],
      },
    ],
    abilities: [
      "Righteous Persecution: after this unit shoots, pick one hit non-MONSTER/VEHICLE enemy unit: -2 Move and -2 Charge until your next turn.",
    ],
    keywords: ["INFANTRY", "PSYKER"],
    enhancement: "Boons of Deimos",
    isPurgationSquad: true,
  },
  {
    id: "purgation-squad-b",
    name: "Purgation 5",
    points: 130,
    composition: "5 models: Purgator Justicar + 4 Purgator",
    statline: { move: "6\"", toughness: 4, save: 2, wounds: 2, leadership: "6+", oc: 1 },
    loadouts: [
      // Justicar carries a Nemesis force weapon, not a Close combat weapon —
      // corrected against the actual army list export.
      { label: "Justicar", count: 1, meleeWeapon: "Nemesis force weapon", rangedWeapons: ["Storm bolter"] },
      { label: "4 Purgator (psycannon)", count: 4, meleeWeapon: "Close combat weapon", rangedWeapons: ["Psycannon"] },
    ],
    abilities: [
      "Righteous Persecution: after this unit shoots, pick one hit non-MONSTER/VEHICLE enemy unit: -2 Move and -2 Charge until your next turn.",
    ],
    keywords: ["INFANTRY", "PSYKER"],
    isPurgationSquad: true,
  },
  {
    id: "purgation-squad-c",
    name: "Purgation 5",
    points: 135,
    composition: "5 models: Purgator Justicar + 4 Purgator",
    statline: { move: "6\"", toughness: 4, save: 2, wounds: 2, leadership: "6+", oc: 1 },
    loadouts: [
      // Justicar carries a Nemesis force weapon, not a Close combat weapon —
      // corrected against the actual army list export.
      { label: "Justicar", count: 1, meleeWeapon: "Nemesis force weapon", rangedWeapons: ["Storm bolter"] },
      { label: "1 Purgator (psilencer)", count: 1, meleeWeapon: "Close combat weapon", rangedWeapons: ["Psilencer"] },
      { label: "3 Purgator (psycannon)", count: 3, meleeWeapon: "Close combat weapon", rangedWeapons: ["Psycannon"] },
    ],
    abilities: [
      "Righteous Persecution: after this unit shoots, pick one hit non-MONSTER/VEHICLE enemy unit: -2 Move and -2 Charge until your next turn.",
    ],
    keywords: ["INFANTRY", "PSYKER"],
    isPurgationSquad: true,
  },
];

export const ARMY_TOTAL_POINTS = ROSTER.reduce((sum, u) => sum + u.points, 0);
