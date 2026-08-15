export type DiceSpec = number | { dice: "D3" | "D6"; flat?: number };

export interface WeaponProfile {
  name: string;
  isMelee: boolean;
  range?: number; // inches; undefined for melee
  attacks: DiceSpec;
  skill: number; // BS or WS, e.g. 3 means "3+"
  strength: number;
  ap: number; // positive number representing how much it worsens the save, e.g. AP2 = -2
  damage: DiceSpec;
  keywords: WeaponKeywords;
  /** [PSYCHIC] tag — not a damage-math keyword itself, but gates eligibility for
   * stratagems like Truesilver Channelling (Devastating Wounds for psychic weapons). */
  isPsychic?: boolean;
}

export interface WeaponKeywords {
  torrent?: boolean;
  rapidFire?: number; // X
  melta?: number; // X
  blast?: boolean;
  sustainedHits?: number; // X, bonus hits on crit
  lethalHits?: boolean;
  devastatingWounds?: boolean;
  twinLinked?: boolean;
  antiKeyword?: string; // e.g. "INFANTRY"
  antiThreshold?: number; // Y+ for anti-X
  ignoresCover?: boolean;
  precision?: boolean;
  extraAttacksName?: string;
}

export interface DefenseModelGroup {
  label: string;
  count: number;
  toughness: number;
  save: number; // e.g. 3 means 3+
  invulnSave?: number; // e.g. 4 means 4+
  wounds: number;
  feelNoPain?: number; // e.g. 5 means 5+
  isAttachedCharacter?: boolean; // excluded from normal allocation, only via PRECISION
}

/**
 * Defensive stratagems/rules toggled on for a TARGET — these reduce
 * whatever attacks are made against it, regardless of which unit is
 * attacking or from what phase. Generic 10e/11e-style rules (not gated by
 * unit keyword/eligibility, since we don't have per-opponent-unit ability
 * data to check against — see the toggle UI's own note about this
 * assumption). All stack independently of each other and of any other
 * modifier already in play.
 */
export interface DefensiveSettings {
  /** -1 to incoming Wound rolls. Cannot take the required roll below a 2+
   * (handled naturally by the existing hit/wound-roll modifier math: a
   * natural 1 always fails and a natural 6 always succeeds regardless of
   * modifiers, and modifiers only ever shift the roll by a net ±1). */
  minusOneToWound: boolean;
  /** -1 to incoming attacks' Damage characteristic, floored at 1 per
   * attack/mortal wound (never reduces to 0 or below). */
  minusOneToDamage: boolean;
  /** -1 to incoming attacks' AP, floored at 0 (an AP0 attack stays AP0, it
   * can never become "better than no penalty"). */
  minusOneToAP: boolean;
}

export const DEFAULT_DEFENSIVE_SETTINGS: DefensiveSettings = {
  minusOneToWound: false,
  minusOneToDamage: false,
  minusOneToAP: false,
};

export interface TargetUnit {
  name: string;
  groups: DefenseModelGroup[];
  isAttached: boolean;
  hasCover: boolean;
  modelCountForBlast: number; // total models in unit at time of targeting, for [BLAST]
  /** Target's own keywords (e.g. "INFANTRY"), uppercased. Required to gate
   * [ANTI-X Y+] — that ability only triggers against a target with the
   * matching keyword, not universally. */
  keywords: string[];
  /** This target's own currently-toggled defensive rules, applied to every
   * attack made against it (any attacker, any phase). Undefined/omitted
   * means none active. */
  defensiveSettings?: DefensiveSettings;
}

export interface AttackContext {
  numAttackingModels: number;
  weapon: WeaponProfile;
  target: TargetUnit;
  halfRange: boolean; // for RAPID FIRE / MELTA
  hitMod: number; // capped to [-1, 1] by caller
  woundMod: number; // capped to [-1, 1] by caller
  strengthBonus: number; // e.g. Boons of Deimos +2
  attacksBonus?: number; // flat bonus Attacks per attacking model, e.g. Champion of the Order of Purifiers +1
  bonusSustainedHits?: number; // e.g. Focused Immolation grants SUSTAINED HITS 1 (stacks/adds)
  grantDevastatingWounds?: boolean; // e.g. Truesilver Channelling / Focused Immolation
  usePrecisionOnCharacter?: boolean; // manual toggle: allocate precision attacks to attached character
  /** Defensive -1 to AP granted by the TARGET (not the attacker) — reduces
   * the weapon's AP before computing the save threshold, floored at 0. */
  apReduction?: number;
  /** Defensive -1 to Damage granted by the TARGET — subtracted from the
   * weapon's resolved Damage characteristic (after Melta etc.), floored at
   * 1 per unsaved wound/mortal wound. */
  damageReduction?: number;
}

export interface SimulationSummary {
  label: string;
  iterations: number;
  meanDamage: number;
  medianDamage: number;
  modeDamage: number;
  stdDevDamage: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  killProbability: number; // probability the target unit is fully destroyed
  meanModelsKilled: number;
  meanWoundsRemaining: number;
  wipeProbability: number;
}
