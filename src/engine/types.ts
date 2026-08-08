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

export interface TargetUnit {
  name: string;
  groups: DefenseModelGroup[];
  isAttached: boolean;
  hasCover: boolean;
  modelCountForBlast: number; // total models in unit at time of targeting, for [BLAST]
}

export interface AttackContext {
  numAttackingModels: number;
  weapon: WeaponProfile;
  target: TargetUnit;
  halfRange: boolean; // for RAPID FIRE / MELTA
  hitMod: number; // capped to [-1, 1] by caller
  woundMod: number; // capped to [-1, 1] by caller
  strengthBonus: number; // e.g. Boons of Deimos +2
  bonusSustainedHits?: number; // e.g. Focused Immolation grants SUSTAINED HITS 1 (stacks/adds)
  grantDevastatingWounds?: boolean; // e.g. Truesilver Channelling / Focused Immolation
  usePrecisionOnCharacter?: boolean; // manual toggle: allocate precision attacks to attached character
}

export interface SimulationSummary {
  label: string;
  iterations: number;
  meanDamage: number;
  medianDamage: number;
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
