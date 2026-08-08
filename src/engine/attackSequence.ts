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

interface Pool {
  group: DefenseModelGroup;
  modelsAlive: number;
  currentModelWoundsLeft: number;
}

function makePools(groups: DefenseModelGroup[]): Pool[] {
  return groups.map((g) => ({
    group: g,
    modelsAlive: g.count,
    currentModelWoundsLeft: g.wounds,
  }));
}

function totalWoundsRemaining(pools: Pool[]): number {
  return pools.reduce((sum, p) => {
    if (p.modelsAlive <= 0) return sum;
    return sum + p.currentModelWoundsLeft + (p.modelsAlive - 1) * p.group.wounds;
  }, 0);
}

function totalModelsAlive(pools: Pool[]): number {
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

export function simulateEngagement(
  ctx: AttackContext,
  rng: () => number,
  rerolls: RerollFlags = {}
): EngagementResult {
  const { weapon, target, numAttackingModels } = ctx;
  const w = weapon.keywords;

  const nonCharacterGroups = target.groups.filter((g) => !g.isAttachedCharacter);
  const characterGroups = target.groups.filter((g) => g.isAttachedCharacter);
  const nonCharPools = makePools(nonCharacterGroups);
  const charPools = makePools(characterGroups);

  const startingWounds = totalWoundsRemaining(nonCharPools) + totalWoundsRemaining(charPools);

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

  interface WoundingAttack {
    saveRoll: number;
    failed: boolean;
    usesInvuln: boolean;
    damage: number;
    isDevastating: boolean;
    isPrecisionEligible: boolean;
  }
  const woundingAttacks: WoundingAttack[] = [];
  let devastatingMortalWounds: { damage: number; isPrecisionEligible: boolean }[] = [];

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

  // Sustained-hit-generated bonus hits and lethal-hit auto-wounds are folded into
  // the counters above; now resolve wound rolls for the (hits - lethalHitWounds)
  // normal hits, plus queue the lethal-hit auto-wounds directly.
  const normalHits = hits - lethalHitWounds;

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
      devastatingMortalWounds.push({
        damage: rollDiceSpec(weapon.damage, rng),
        isPrecisionEligible,
      });
      return;
    }
    resolveSave(isPrecisionEligible);
  };

  const resolveSave = (isPrecisionEligible: boolean) => {
    const targetGroup = pickRepresentativeGroup(nonCharacterGroups, characterGroups);
    if (!targetGroup) return;
    const { threshold, usesInvuln } = saveThreshold(targetGroup, weapon.ap);
    let saveRoll = d6(rng);
    const failed = saveRoll === 1 || saveRoll < threshold;
    woundingAttacks.push({
      saveRoll,
      failed,
      usesInvuln,
      damage: failed ? rollDiceSpec(weapon.damage, rng) : 0,
      isDevastating: false,
      isPrecisionEligible,
    });
  };

  for (let i = 0; i < normalHits; i++) doWoundRoll(false);
  // Lethal-hit auto-wounds still go through the save step (they only skip the wound roll).
  for (let i = 0; i < lethalHitWounds; i++) {
    const targetGroup = pickRepresentativeGroup(nonCharacterGroups, characterGroups);
    if (!targetGroup) continue;
    const { threshold } = saveThreshold(targetGroup, weapon.ap);
    const saveRoll = d6(rng);
    const failed = saveRoll === 1 || saveRoll < threshold;
    woundingAttacks.push({
      saveRoll,
      failed,
      usesInvuln: false,
      damage: failed ? rollDiceSpec(weapon.damage, rng) : 0,
      isDevastating: false,
      isPrecisionEligible: false,
    });
  }

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
      // "capped at killing one model per critical-wound instance, excess lost"
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

  const woundsRemaining = totalWoundsRemaining(nonCharPools) + totalWoundsRemaining(charPools);
  const unitWiped = totalModelsAlive(nonCharPools) + totalModelsAlive(charPools) === 0;
  const modelsKilled =
    target.groups.reduce((sum, g) => sum + g.count, 0) -
    (totalModelsAlive(nonCharPools) + totalModelsAlive(charPools));

  return { damageDealt, modelsKilled, woundsRemaining, startingWounds, unitWiped };
}

function clampMod(mod: number): number {
  return Math.max(-1, Math.min(1, mod));
}

/**
 * Save threshold (Sv/InvSv) is computed from the first non-character group.
 * This is exact for the common case of a single-profile target (the default
 * for auto-generated matchups). For a genuinely mixed-save squad this is a
 * simplification — full per-model save variance isn't modeled.
 */
function pickRepresentativeGroup(
  nonCharacterGroups: DefenseModelGroup[],
  characterGroups: DefenseModelGroup[]
): DefenseModelGroup | undefined {
  return nonCharacterGroups[0] ?? characterGroups[0];
}
