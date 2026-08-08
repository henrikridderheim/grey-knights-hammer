import { d6, rollDiceSpec } from "./dice";
import type { AttackContext, DefenseModelGroup } from "./types";

/**
 * Simplifying assumptions, documented because the live 11e rules leave some of
 * this to player choice during a real game:
 * - Re-roll abilities (e.g. [TWIN-LINKED], Fury of Titan re-rolls) are applied
 *   optimally: reroll iff the first roll did not succeed. We never "fish" a
 *   pass for a better (critical) result.
 * - When a defender has more than one eligible fresh (undamaged) model to
 *   allocate a failed save to, we fill defense groups in the order given
 *   rather than modeling optimal defender choice.
 * - Feel No Pain is applied to both normal failed-save damage and to
 *   Devastating Wounds mortal wounds, per point of damage, as per its
 *   standard wording.
 * - Save threshold (Sv/InvSv) is computed from the first non-character group.
 *   Exact for a single-profile target (the common case); a simplification for
 *   a genuinely mixed-save squad.
 */

export interface RerollFlags {
  hitRerollOnes?: boolean; // e.g. Fury of Titan grants re-roll Hit roll of 1
  woundRerollOnes?: boolean; // e.g. Fury of Titan grants re-roll Wound roll of 1
}

export interface EngagementResult {
  damageDealt: number;
  modelsKilled: number;
  woundsRemaining: number;
  startingWounds: number;
  unitWiped: boolean;
}

export interface Pool {
  group: DefenseModelGroup;
  modelsAlive: number;
  currentModelWoundsLeft: number;
}

export interface TargetPools {
  nonCharPools: Pool[];
  charPools: Pool[];
  totalModelsStart: number;
}

export function buildTargetPools(target: AttackContext["target"]): TargetPools {
  const nonCharacterGroups = target.groups.filter((g) => !g.isAttachedCharacter);
  const characterGroups = target.groups.filter((g) => g.isAttachedCharacter);
  return {
    nonCharPools: makePools(nonCharacterGroups),
    charPools: makePools(characterGroups),
    totalModelsStart: target.groups.reduce((sum, g) => sum + g.count, 0),
  };
}

function makePools(groups: DefenseModelGroup[]): Pool[] {
  return groups.map((g) => ({
    group: g,
    modelsAlive: g.count,
    currentModelWoundsLeft: g.wounds,
  }));
}

export function totalWoundsRemaining(pools: Pool[]): number {
  return pools.reduce((sum, p) => {
    if (p.modelsAlive <= 0) return sum;
    return sum + p.currentModelWoundsLeft + (p.modelsAlive - 1) * p.group.wounds;
  }, 0);
}

export function totalModelsAlive(pools: Pool[]): number {
  return pools.reduce((sum, p) => sum + p.modelsAlive, 0);
}

function applyFeelNoPain(rawDamage: number, feelNoPain: number | undefined, rng: () => number): number {
  if (!feelNoPain || rawDamage <= 0) return rawDamage;
  let effective = 0;
  for (let i = 0; i < rawDamage; i++) {
    if (d6(rng) < feelNoPain) effective++;
  }
  return effective;
}

/** Apply `damage` points to the next available model(s) in this pool. Excess from a
 * single attack that kills the current model is lost (no overflow), per verified 11e rule. */
function applyDamageToPool(pool: Pool, damage: number, feelNoPain: number | undefined, rng: () => number): number {
  if (pool.modelsAlive <= 0 || damage <= 0) return 0;
  const effectiveDamage = applyFeelNoPain(damage, feelNoPain, rng);
  if (effectiveDamage <= 0) return 0;
  // Excess beyond the current model's remaining wounds is lost, not carried to the next model.
  const dealt = Math.min(effectiveDamage, pool.currentModelWoundsLeft);
  pool.currentModelWoundsLeft -= dealt;
  if (pool.currentModelWoundsLeft <= 0) {
    pool.modelsAlive -= 1;
    pool.currentModelWoundsLeft = pool.modelsAlive > 0 ? pool.group.wounds : 0;
  }
  return dealt;
}

function saveThreshold(group: DefenseModelGroup, ap: number): { threshold: number; usesInvuln: boolean } {
  const armor = group.save + ap;
  const invuln = group.invulnSave ?? 8; // 8 = effectively "never" (impossible on a d6)
  if (invuln < armor) return { threshold: invuln, usesInvuln: true };
  return { threshold: armor, usesInvuln: false };
}

function woundThreshold(strength: number, toughness: number): number {
  if (strength >= toughness * 2) return 2;
  if (strength > toughness) return 3;
  if (strength === toughness) return 4;
  if (strength * 2 > toughness) return 5;
  return 6;
}

function clampMod(mod: number): number {
  return Math.max(-1, Math.min(1, mod));
}

function pickRepresentativeGroup(
  nonCharacterGroups: DefenseModelGroup[],
  characterGroups: DefenseModelGroup[]
): DefenseModelGroup | undefined {
  return nonCharacterGroups[0] ?? characterGroups[0];
}

/**
 * Fire one weapon against shared, mutable target pools (used both for a single-weapon
 * engagement and for combining multiple weapons from the same unit in one phase, so
 * overkill/model-death is correctly shared rather than each weapon seeing a fresh target).
 */
export function fireWeaponAtPools(
  ctx: AttackContext,
  pools: TargetPools,
  rng: () => number,
  rerolls: RerollFlags = {}
): number {
  const { weapon, target, numAttackingModels } = ctx;
  const w = weapon.keywords;
  const { nonCharPools, charPools } = pools;
  const nonCharacterGroups = nonCharPools.map((p) => p.group);
  const characterGroups = charPools.map((p) => p.group);

  // --- Gather attack dice ---
  let totalAttacks = 0;
  const rapidFireBonus = ctx.halfRange && w.rapidFire ? w.rapidFire : 0;
  const blastBonus =
    w.blast && target.modelCountForBlast > 0 ? Math.floor(target.modelCountForBlast / 5) : 0;
  for (let m = 0; m < numAttackingModels; m++) {
    totalAttacks += rollDiceSpec(weapon.attacks, rng) + rapidFireBonus + blastBonus;
  }

  // Toughness for wound rolls: if target is an attached unit, use the highest T
  // among bodyguard (non-character) models on the battlefield (verified 11e rule).
  const effectiveToughness = target.isAttached
    ? Math.max(...nonCharacterGroups.map((g) => g.toughness), 0)
    : nonCharacterGroups[0]?.toughness ?? characterGroups[0]?.toughness ?? 0;

  const antiApplies = !!(w.antiKeyword && w.antiThreshold);
  // [MELTA X]: add X to the weapon's Damage characteristic when the target was within half range.
  const meltaBonus = ctx.halfRange && w.melta ? w.melta : 0;
  const rollWeaponDamage = () => rollDiceSpec(weapon.damage, rng) + meltaBonus;

  interface WoundingAttack {
    saveRoll: number;
    failed: boolean;
    damage: number;
    isPrecisionEligible: boolean;
  }
  const woundingAttacks: WoundingAttack[] = [];
  const devastatingMortalWounds: { damage: number; isPrecisionEligible: boolean }[] = [];

  const effectiveStrength = weapon.strength + ctx.strengthBonus;
  const sustainedHitsX = (w.sustainedHits ?? 0) + (ctx.bonusSustainedHits ?? 0);
  const devastatingActive = !!w.devastatingWounds || !!ctx.grantDevastatingWounds;

  // --- Hit roll (with Sustained/Lethal Hits generating bonus/auto-wound hits) ---
  let hits = 0;
  let lethalHitWounds = 0; // hits that auto-wound (skip wound roll)
  const doHitRoll = () => {
    if (w.torrent) {
      hits += 1;
      return;
    }
    let roll = d6(rng);
    if (roll === 1 && rerolls.hitRerollOnes) roll = d6(rng);
    if (roll === 1) return; // always fails
    const isCrit = roll === 6;
    if (!isCrit) {
      const modified = roll + clampMod(ctx.hitMod);
      if (modified < weapon.skill) return; // miss
    }
    hits += 1;
    if (isCrit) {
      if (sustainedHitsX > 0) hits += sustainedHitsX;
      if (w.lethalHits) lethalHitWounds += 1;
    }
  };
  for (let i = 0; i < totalAttacks; i++) doHitRoll();

  const normalHits = hits - lethalHitWounds;

  const resolveSave = (isPrecisionEligible: boolean) => {
    const targetGroup = pickRepresentativeGroup(nonCharacterGroups, characterGroups);
    if (!targetGroup) return;
    const { threshold } = saveThreshold(targetGroup, weapon.ap);
    const saveRoll = d6(rng);
    const failed = saveRoll === 1 || saveRoll < threshold;
    woundingAttacks.push({
      saveRoll,
      failed,
      damage: failed ? rollWeaponDamage() : 0,
      isPrecisionEligible,
    });
  };

  const doWoundRoll = (isPrecisionEligible: boolean) => {
    let roll = d6(rng);
    if (roll === 1 && rerolls.woundRerollOnes) roll = d6(rng);
    if (w.twinLinked && roll !== 6 && roll < woundThreshold(effectiveStrength, effectiveToughness)) {
      roll = d6(rng);
    }
    if (roll === 1) return;
    let isCritWound = roll === 6;
    if (!isCritWound && antiApplies) {
      // Anti-X uses the UNMODIFIED wound roll.
      if (roll >= (w.antiThreshold as number)) isCritWound = true;
    }
    let success = isCritWound;
    if (!success) {
      const modified = roll + clampMod(ctx.woundMod);
      success = modified >= woundThreshold(effectiveStrength, effectiveToughness);
    }
    if (!success) return;

    if (isCritWound && devastatingActive) {
      devastatingMortalWounds.push({ damage: rollWeaponDamage(), isPrecisionEligible });
      return;
    }
    resolveSave(isPrecisionEligible);
  };

  for (let i = 0; i < normalHits; i++) doWoundRoll(false);
  // Lethal-hit auto-wounds still go through the save step (they only skip the wound roll).
  for (let i = 0; i < lethalHitWounds; i++) resolveSave(false);

  // --- Resolve normal damage, ascending order of save roll result (verified 11e rule) ---
  const failedSaves = woundingAttacks.filter((a) => a.failed).sort((a, b) => a.saveRoll - b.saveRoll);
  let damageDealt = 0;
  const canPrecision = !!w.precision && ctx.usePrecisionOnCharacter && charPools.length > 0;
  for (const atk of failedSaves) {
    if (canPrecision && atk.isPrecisionEligible && charPools.some((p) => p.modelsAlive > 0)) {
      const pool = charPools.find((p) => p.modelsAlive > 0)!;
      damageDealt += applyDamageToPool(pool, atk.damage, pool.group.feelNoPain, rng);
    } else {
      const pool = nonCharPools.find((p) => p.modelsAlive > 0);
      if (pool) damageDealt += applyDamageToPool(pool, atk.damage, pool.group.feelNoPain, rng);
    }
  }

  // --- Resolve Devastating Wounds mortal wounds (after normal damage, per verified rule) ---
  for (const dw of devastatingMortalWounds) {
    if (canPrecision && dw.isPrecisionEligible && charPools.some((p) => p.modelsAlive > 0)) {
      const pool = charPools.find((p) => p.modelsAlive > 0)!;
      const cappedDamage = Math.min(dw.damage, pool.currentModelWoundsLeft);
      damageDealt += applyDamageToPool(pool, cappedDamage, pool.group.feelNoPain, rng);
    } else {
      const pool = nonCharPools.find((p) => p.modelsAlive > 0);
      if (pool) {
        const cappedDamage = Math.min(dw.damage, pool.currentModelWoundsLeft);
        damageDealt += applyDamageToPool(pool, cappedDamage, pool.group.feelNoPain, rng);
      }
    }
  }

  return damageDealt;
}

/** Single-weapon convenience wrapper (used directly by unit tests). */
export function simulateEngagement(
  ctx: AttackContext,
  rng: () => number,
  rerolls: RerollFlags = {}
): EngagementResult {
  const pools = buildTargetPools(ctx.target);
  const startingWounds = totalWoundsRemaining(pools.nonCharPools) + totalWoundsRemaining(pools.charPools);
  const damageDealt = fireWeaponAtPools(ctx, pools, rng, rerolls);
  const woundsRemaining = totalWoundsRemaining(pools.nonCharPools) + totalWoundsRemaining(pools.charPools);
  const aliveNow = totalModelsAlive(pools.nonCharPools) + totalModelsAlive(pools.charPools);
  return {
    damageDealt,
    modelsKilled: pools.totalModelsStart - aliveNow,
    woundsRemaining,
    startingWounds,
    unitWiped: aliveNow === 0,
  };
}

/**
 * Fire multiple weapons (e.g. all of a unit's ranged weapons) against ONE shared target
 * in a single phase, so overkill/model-death carries correctly across weapons instead of
 * each weapon seeing a full-health target.
 */
export function simulateUnitPhase(
  engagements: { ctx: AttackContext; rerolls?: RerollFlags }[],
  rng: () => number
): EngagementResult & { damageByWeapon: number[] } {
  if (engagements.length === 0) {
    return { damageDealt: 0, modelsKilled: 0, woundsRemaining: 0, startingWounds: 0, unitWiped: false, damageByWeapon: [] };
  }
  const pools = buildTargetPools(engagements[0].ctx.target);
  const startingWounds = totalWoundsRemaining(pools.nonCharPools) + totalWoundsRemaining(pools.charPools);
  const damageByWeapon: number[] = [];
  let damageDealt = 0;
  for (const { ctx, rerolls } of engagements) {
    const d = fireWeaponAtPools(ctx, pools, rng, rerolls);
    damageByWeapon.push(d);
    damageDealt += d;
  }
  const woundsRemaining = totalWoundsRemaining(pools.nonCharPools) + totalWoundsRemaining(pools.charPools);
  const aliveNow = totalModelsAlive(pools.nonCharPools) + totalModelsAlive(pools.charPools);
  return {
    damageDealt,
    modelsKilled: pools.totalModelsStart - aliveNow,
    woundsRemaining,
    startingWounds,
    unitWiped: aliveNow === 0,
    damageByWeapon,
  };
}
