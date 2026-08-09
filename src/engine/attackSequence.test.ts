import { describe, it, expect } from "vitest";
import { runSimulation } from "./simulate";
import type { AttackContext, TargetUnit, WeaponProfile } from "./types";

// Standard 11e wound-threshold formula, used to derive expected values below:
// S >= 2T -> 2+, S > T -> 3+, S === T -> 4+, S*2 > T -> 5+, else 6+.
// P(success at N+) = (7 - N) / 6, except when N === 1 a natural-1 auto-fail still applies.

function makeTarget(
  overrides: Partial<TargetUnit["groups"][0]> = {},
  isAttached = false,
  keywords: string[] = []
): TargetUnit {
  return {
    name: "Test Target",
    isAttached,
    hasCover: false,
    modelCountForBlast: 10,
    keywords,
    groups: [
      {
        label: "Trooper",
        count: 10,
        toughness: 4,
        save: 7, // no armor save possible
        wounds: 1,
        ...overrides,
      },
    ],
  };
}

function makeWeapon(overrides: Partial<WeaponProfile> = {}): WeaponProfile {
  return {
    name: "Test Weapon",
    isMelee: false,
    range: 24,
    attacks: 10,
    skill: 3,
    strength: 4,
    ap: 0,
    damage: 1,
    keywords: {},
    ...overrides,
  };
}

function baseCtx(overrides: Partial<AttackContext> = {}): AttackContext {
  return {
    numAttackingModels: 1,
    weapon: makeWeapon(),
    target: makeTarget(),
    halfRange: false,
    hitMod: 0,
    woundMod: 0,
    strengthBonus: 0,
    ...overrides,
  };
}

describe("attack sequence — analytical sanity checks", () => {
  it("10 attacks, BS3+, S4 vs T4 (4+ to wound), no save: expected damage ≈ 3.33", () => {
    const ctx = baseCtx();
    const result = runSimulation(ctx, { label: "sanity-1", iterations: 30000 });
    // 10 attacks * P(hit at 3+ = 4/6) * P(wound at 4+ = 3/6) * D1 = 3.333
    expect(result.meanDamage).toBeGreaterThan(3.1);
    expect(result.meanDamage).toBeLessThan(3.6);
  });

  it("hit roll of natural 1 always fails even with a very low skill threshold", () => {
    const ctx = baseCtx({
      weapon: makeWeapon({ skill: 2, attacks: 10000 }),
      target: makeTarget({ save: 7, wounds: 10_000_000, count: 1 }), // uncapped, isolate the probability
    });
    const result = runSimulation(ctx, { label: "sanity-nat1", iterations: 200 });
    // Hits ≈ attacks * 5/6 (natural 1 always fails despite skill 2+ needing only >=2).
    // Wound at S4 vs T4 = 4+ = 3/6.
    const expectedDamage = 10000 * (5 / 6) * (3 / 6);
    expect(result.meanDamage).toBeGreaterThan(expectedDamage * 0.95);
    expect(result.meanDamage).toBeLessThan(expectedDamage * 1.05);
  });

  it("Devastating Wounds triggers on natural 6 wound roll (~1/6 of hits) regardless of modifiers", () => {
    const ctx = baseCtx({
      weapon: makeWeapon({
        attacks: 10000,
        skill: 2, // guarantee hits are dominated by non-1 rolls
        damage: 2,
        keywords: { devastatingWounds: true },
      }),
      target: makeTarget({ wounds: 2, save: 2, count: 1_000_000 }), // effectively uncapped, W2 so a crit exactly kills, no excess
    });
    const result = runSimulation(ctx, { label: "sanity-dw", iterations: 200 });
    // hits ≈ attacks * 5/6 (natural1 excluded). Wound at S4vT4 = 4+: crit (nat 6) = 1/6 of attacks,
    // non-crit success (rolls 4,5) = 2/6 of attacks.
    // Crit wounds bypass the save entirely (Devastating Wounds) -> 2 mortal wounds each, capped at W2, no excess.
    // Non-crit successes still roll a normal Sv2+/AP0 save, which only fails on a natural 1 (1/6).
    const hits = 10000 * (5 / 6);
    const critWounds = hits * (1 / 6);
    const nonCritWounds = hits * (2 / 6);
    const devastatingDamage = critWounds * 2;
    const normalDamage = nonCritWounds * (1 / 6) * 2;
    const expectedDamage = devastatingDamage + normalDamage;
    expect(result.meanDamage).toBeGreaterThan(expectedDamage * 0.9);
    expect(result.meanDamage).toBeLessThan(expectedDamage * 1.1);
  });

  it("Sustained Hits 1 adds ~1/6 bonus hits per attack on critical hits", () => {
    const ctx = baseCtx({
      weapon: makeWeapon({ attacks: 10000, skill: 3, keywords: { sustainedHits: 1 } }),
      target: makeTarget({ save: 7, wounds: 10_000_000, count: 1 }), // uncapped
    });
    const result = runSimulation(ctx, { label: "sanity-sustained", iterations: 200 });
    // normal successes on rolls {3,4,5,6} = 4/6; crit fraction of attacks = 1/6 (bonus hits); wound at S4vT4 = 3/6
    const expectedHits = 10000 * (4 / 6) + 10000 * (1 / 6);
    const expectedDamage = expectedHits * (3 / 6);
    expect(result.meanDamage).toBeGreaterThan(expectedDamage * 0.9);
    expect(result.meanDamage).toBeLessThan(expectedDamage * 1.1);
  });

  it("no damage overflow: excess damage from a single attack that kills a model is lost", () => {
    // One attack, S4 vs T4, Damage 6 vs a model with 1 wound in a unit of 2.
    // Only 1 model should die; the other 5 excess damage must NOT carry over.
    const ctx = baseCtx({
      weapon: makeWeapon({ attacks: 1, skill: 2, damage: 6 }),
      target: makeTarget({ count: 2, wounds: 1, save: 7 }),
    });
    const result = runSimulation(ctx, { label: "sanity-overflow", iterations: 20000 });
    // P(deal damage) = P(hit at 2+, nat1 excluded = 5/6) * P(wound at 4+ = 3/6) = 5/12 ≈ 0.417,
    // and when it lands, damage is capped at 1 (the single model's wound pool) — never near 6.
    expect(result.meanDamage).toBeGreaterThan(0.35);
    expect(result.meanDamage).toBeLessThan(0.48);
  });

  it("Feel No Pain reduces expected damage per point, applied per point of damage", () => {
    const noFnp = baseCtx({
      weapon: makeWeapon({ attacks: 10000, skill: 2, damage: 1 }),
      target: makeTarget({ save: 7, wounds: 10_000_000, count: 1 }),
    });
    const withFnp = baseCtx({
      weapon: makeWeapon({ attacks: 10000, skill: 2, damage: 1 }),
      target: makeTarget({ save: 7, wounds: 10_000_000, count: 1, feelNoPain: 5 }), // FNP 5+ ignores 2/6 of damage points
    });
    const rNo = runSimulation(noFnp, { label: "fnp-off", iterations: 100 });
    const rYes = runSimulation(withFnp, { label: "fnp-on", iterations: 100 });
    // FNP 5+ should negate roughly 2/6 (33%) of damage points, leaving ~2/3.
    const ratio = rYes.meanDamage / rNo.meanDamage;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.72);
  });

  it("Melta X adds X Damage only when the target was within half range (regression: this was previously unimplemented)", () => {
    const meltaWeapon = makeWeapon({
      attacks: 10000,
      skill: 2,
      strength: 9,
      damage: 1,
      keywords: { melta: 4 },
    });
    const target = makeTarget({ save: 7, wounds: 10_000_000, count: 1 }); // uncapped, no save
    const halfRange = baseCtx({ weapon: meltaWeapon, target, halfRange: true });
    const fullRange = baseCtx({ weapon: meltaWeapon, target, halfRange: false });
    const rHalf = runSimulation(halfRange, { label: "melta-half", iterations: 100 });
    const rFull = runSimulation(fullRange, { label: "melta-full", iterations: 100 });
    // Same hit/wound math either way (S9 vs T4 = 2+ to wound); only Damage differs: 1+4=5 vs 1.
    // So half-range damage should be ~5x full-range damage.
    const ratio = rHalf.meanDamage / rFull.meanDamage;
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(5.5);
  });

  it("[ANTI-X Y+] only triggers against a target that actually has keyword X (regression: previously applied to every target universally)", () => {
    const antiInfantryWeapon = makeWeapon({
      attacks: 10000,
      skill: 2,
      strength: 4,
      damage: 1,
      keywords: { antiKeyword: "INFANTRY", antiThreshold: 2 },
    });
    // S4 vs T8: S*2 (8) is not > T (8), so this is a 6+ to wound normally (only
    // a natural 6 succeeds) — ANTI-INFANTRY 2+ would make almost every non-1
    // roll a critical wound instead if it wrongly applied against a non-Infantry target.
    const nonInfantryTarget = makeTarget({ save: 7, toughness: 8, wounds: 10_000_000, count: 1 }, false, ["VEHICLE"]);
    const infantryTarget = makeTarget({ save: 7, toughness: 8, wounds: 10_000_000, count: 1 }, false, ["INFANTRY"]);
    const ctxNonInfantry = baseCtx({ weapon: antiInfantryWeapon, target: nonInfantryTarget });
    const ctxInfantry = baseCtx({ weapon: antiInfantryWeapon, target: infantryTarget });
    const rNonInfantry = runSimulation(ctxNonInfantry, { label: "anti-vs-vehicle", iterations: 100 });
    const rInfantry = runSimulation(ctxInfantry, { label: "anti-vs-infantry", iterations: 100 });
    // Against VEHICLE (no matching keyword): normal S4vT8 = 6+ to wound = 1/6 of attacks.
    const expectedNonInfantry = 10000 * (5 / 6) * (1 / 6);
    expect(rNonInfantry.meanDamage).toBeGreaterThan(expectedNonInfantry * 0.9);
    expect(rNonInfantry.meanDamage).toBeLessThan(expectedNonInfantry * 1.1);
    // Against INFANTRY: ANTI-INFANTRY 2+ makes any unmodified roll of 2+ a critical wound = 5/6 of attacks — much higher.
    const expectedInfantry = 10000 * (5 / 6) * (5 / 6);
    expect(rInfantry.meanDamage).toBeGreaterThan(expectedInfantry * 0.9);
    expect(rInfantry.meanDamage).toBeLessThan(expectedInfantry * 1.1);
  });

  it("re-roll-all-failed-wounds (e.g. Sanctity of Purpose near an objective) rerolls any failure, not just natural 1s", () => {
    const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 4 }); // S4vT4 = 4+ to wound = 3/6
    const target = makeTarget({ save: 7, toughness: 4, wounds: 10_000_000, count: 1 });
    const ctx = baseCtx({ weapon, target });
    const rBase = runSimulation(ctx, { label: "reroll-off", iterations: 100 });
    const rRerollAll = runSimulation(ctx, {
      label: "reroll-all",
      iterations: 100,
      rerolls: { woundRerollAllFailed: true },
    });
    // P(wound) with no reroll = 3/6 = 0.5; with reroll-all-failed = 1 - (3/6)^2 = 0.75 (a 1.5x jump,
    // much bigger than the ~1.17x a reroll-1s-only ability would give).
    const ratio = rRerollAll.meanDamage / rBase.meanDamage;
    expect(ratio).toBeGreaterThan(1.35);
    expect(ratio).toBeLessThan(1.65);
  });

  it("attacksBonus adds a flat bonus Attack per attacking model (e.g. Champion of the Order of Purifiers)", () => {
    const weapon = makeWeapon({ attacks: 1, skill: 2, strength: 4 }); // S4vT4 = 4+ to wound = 3/6
    const target = makeTarget({ save: 7, toughness: 4, wounds: 10_000_000, count: 1 });
    const noBonus = baseCtx({ weapon, target, numAttackingModels: 10000 });
    const withBonus = baseCtx({ weapon, target, numAttackingModels: 10000, attacksBonus: 1 });
    const rNoBonus = runSimulation(noBonus, { label: "attacks-bonus-off", iterations: 100 });
    const rWithBonus = runSimulation(withBonus, { label: "attacks-bonus-on", iterations: 100 });
    // 1 attack/model -> 2 attacks/model roughly doubles total attacks, and therefore damage.
    const ratio = rWithBonus.meanDamage / rNoBonus.meanDamage;
    expect(ratio).toBeGreaterThan(1.85);
    expect(ratio).toBeLessThan(2.15);
  });
});
