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

describe("Rugged Resilience (-1 to wound when attacker S > target T)", () => {
  const target = (rugged: boolean): TargetUnit => ({
    ...makeTarget({ toughness: 5, save: 7, wounds: 1, count: 40 }),
    ruggedResilience: rugged,
  });

  it("reduces wounding when Strength exceeds Toughness (S6 vs T5: 3+ becomes an effective 4+)", () => {
    const weapon = makeWeapon({ strength: 6, skill: 2, attacks: 20 }); // S6 > T5, hits on 2+
    const on = runSimulation(baseCtx({ weapon, target: target(true) }), { label: "rugged-on", iterations: 20000 });
    const off = runSimulation(baseCtx({ weapon, target: target(false) }), { label: "rugged-off", iterations: 20000 });
    // off: 20 * 5/6 hit * 4/6 wound ≈ 11.1 ; on: * 3/6 wound ≈ 8.33
    expect(off.meanDamage).toBeGreaterThan(10.3);
    expect(on.meanDamage).toBeGreaterThan(7.5);
    expect(on.meanDamage).toBeLessThan(9.1);
    expect(on.meanDamage).toBeLessThan(off.meanDamage - 1.5);
  });

  it("does NOT apply when Strength is not greater than Toughness (S5 vs T5 unchanged)", () => {
    const weapon = makeWeapon({ strength: 5, skill: 2, attacks: 20 }); // S5 == T5, not greater
    const on = runSimulation(baseCtx({ weapon, target: target(true) }), { label: "eqT-on", iterations: 20000 });
    const off = runSimulation(baseCtx({ weapon, target: target(false) }), { label: "eqT-off", iterations: 20000 });
    expect(Math.abs(on.meanDamage - off.meanDamage)).toBeLessThan(0.6);
  });
});

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

  describe("defensive toggles (-1 Wound / -1 Damage / -1 AP)", () => {
    it("-1 to Wound worsens the wound roll needed by one step (S4vT4 4+ becomes effectively 5+)", () => {
      const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 4 }); // S4vT4 = 4+ to wound = 3/6
      const target = makeTarget({ save: 7, toughness: 4, wounds: 10_000_000, count: 1 });
      const base = baseCtx({ weapon, target });
      const debuffed = baseCtx({ weapon, target, woundMod: -1 });
      const rBase = runSimulation(base, { label: "wound-mod-off", iterations: 100 });
      const rDebuffed = runSimulation(debuffed, { label: "wound-mod-on", iterations: 100 });
      // 4+ (3/6) -> effectively 5+ (2/6): ratio ≈ 2/3.
      const ratio = rDebuffed.meanDamage / rBase.meanDamage;
      expect(ratio).toBeGreaterThan(0.55);
      expect(ratio).toBeLessThan(0.78);
    });

    it("-1 to Wound never stops a natural 6 from auto-succeeding, even against an already-6+-to-wound target", () => {
      // S1 vs T100: S*2 (2) is not > T, so this is already the worst case, 6+ to wound.
      const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 1 });
      const target = makeTarget({ save: 7, toughness: 100, wounds: 10_000_000, count: 1 });
      const ctx = baseCtx({ weapon, target, woundMod: -1 });
      const result = runSimulation(ctx, { label: "wound-mod-floor", iterations: 100 });
      // Hits ≈ attacks * 5/6 (nat1 excluded); of those, only a natural 6 (1/6) wounds regardless of -1.
      const expectedDamage = 10000 * (5 / 6) * (1 / 6);
      expect(result.meanDamage).toBeGreaterThan(expectedDamage * 0.85);
      expect(result.meanDamage).toBeLessThan(expectedDamage * 1.15);
    });

    it("-1 to Damage reduces resolved damage per unsaved wound, floored at 1 (never reaches 0)", () => {
      // Damage 1 flat: reducing by 1 would naively give 0, but the floor keeps it at 1 —
      // so with-vs-without should show NO difference here.
      const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 10, damage: 1 });
      const target = makeTarget({ save: 7, toughness: 1, wounds: 10_000_000, count: 1 });
      const base = baseCtx({ weapon, target });
      const debuffed = baseCtx({ weapon, target, damageReduction: 1 });
      const rBase = runSimulation(base, { label: "dmg-floor-off", iterations: 100 });
      const rDebuffed = runSimulation(debuffed, { label: "dmg-floor-on", iterations: 100 });
      const ratio = rDebuffed.meanDamage / rBase.meanDamage;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    });

    it("-1 to Damage reduces a Damage-2 weapon's output by roughly half (2 -> 1 per unsaved wound)", () => {
      const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 10, damage: 2 });
      const target = makeTarget({ save: 7, toughness: 1, wounds: 10_000_000, count: 1 });
      const base = baseCtx({ weapon, target });
      const debuffed = baseCtx({ weapon, target, damageReduction: 1 });
      const rBase = runSimulation(base, { label: "dmg-half-off", iterations: 100 });
      const rDebuffed = runSimulation(debuffed, { label: "dmg-half-on", iterations: 100 });
      const ratio = rDebuffed.meanDamage / rBase.meanDamage;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.6);
    });

    it("-1 to AP makes the save easier (AP2 effectively becomes AP1)", () => {
      const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 10, ap: 2, damage: 1 });
      const target = makeTarget({ save: 3, toughness: 1, wounds: 10_000_000, count: 1 }); // Sv3+, AP2 -> armor 5+
      const base = baseCtx({ weapon, target });
      const debuffed = baseCtx({ weapon, target, apReduction: 1 });
      const rBase = runSimulation(base, { label: "ap-reduce-off", iterations: 100 });
      const rDebuffed = runSimulation(debuffed, { label: "ap-reduce-on", iterations: 100 });
      // Save 5+ (fails 4/6) -> effectively save 4+ (fails 3/6): damage ratio ≈ 3/4.
      const ratio = rDebuffed.meanDamage / rBase.meanDamage;
      expect(ratio).toBeGreaterThan(0.65);
      expect(ratio).toBeLessThan(0.85);
    });

    it("-1 to AP cannot improve an already-AP0 attack (floored at 0, no advantage granted)", () => {
      const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 10, ap: 0, damage: 1 });
      const target = makeTarget({ save: 3, toughness: 1, wounds: 10_000_000, count: 1 });
      const base = baseCtx({ weapon, target });
      const debuffed = baseCtx({ weapon, target, apReduction: 1 });
      const rBase = runSimulation(base, { label: "ap-floor-off", iterations: 100 });
      const rDebuffed = runSimulation(debuffed, { label: "ap-floor-on", iterations: 100 });
      const ratio = rDebuffed.meanDamage / rBase.meanDamage;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    });

    it("all three stack together", () => {
      const weapon = makeWeapon({ attacks: 10000, skill: 2, strength: 4, ap: 2, damage: 2 });
      const target = makeTarget({ save: 3, toughness: 4, wounds: 10_000_000, count: 1 });
      const base = baseCtx({ weapon, target });
      const stacked = baseCtx({ weapon, target, woundMod: -1, apReduction: 1, damageReduction: 1 });
      const rBase = runSimulation(base, { label: "stack-off", iterations: 100 });
      const rStacked = runSimulation(stacked, { label: "stack-on", iterations: 100 });
      // Each individual effect reduces damage on its own; combined should be meaningfully lower
      // than any single one of them (roughly 0.5-0.7 * 0.75-0.85 * 0.5, well under 0.5 overall).
      const ratio = rStacked.meanDamage / rBase.meanDamage;
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(0.5);
    });
  });

  describe("reroll timing vs. modifiers (11e core rule: rerolls happen before modifiers)", () => {
    it("twin-linked + a wound modifier: reroll eligibility is decided on the RAW roll, not the modified one", () => {
      // S9 vs T5 = 3+ base wound threshold (S>T, not >=2T). Twin-linked +
      // -1 to Wound. Correct sequencing: raw roll of 3 counts as a RAW PASS
      // (3 >= 3), so it is NOT eligible for a twin-linked reroll — the -1 is
      // then applied to that same roll, making it fail (2 < 3), but no
      // reroll happens. A roll of 1 or 2 raw-fails and DOES reroll.
      // P(correct) = P(raw pass, survives or not after -1) + P(raw fail, reroll, then -1 applied to the new roll)
      //   raw pass rolls {3,4,5,6} (4/6): after -1, only {4,5,6} (3/6 of all) still pass; roll=3 becomes a final fail, no reroll.
      //   raw fail rolls {1,2} (2/6): reroll once, new roll r' — final success needs r'-1>=3 i.e. r' in {4,5,6} (3/6).
      //   total = 3/6 + (2/6)(3/6) = 3/6 + 1/6 = 4/6 ≈ 0.667.
      // The bug this guards against: deciding reroll on the MODIFIED result
      // instead would also reroll a raw-passing roll of 3 (since 3-1=2 fails
      // the modified check), giving it a second chance it isn't entitled to
      // — inflating P(success) to 0.75 instead of the correct 0.667.
      const weapon = makeWeapon({ attacks: 100000, skill: 2, strength: 9, keywords: { twinLinked: true } });
      const target = makeTarget({ save: 7, toughness: 5, wounds: 10_000_000, count: 1 });
      const ctx = baseCtx({ weapon, target, woundMod: -1 });
      const result = runSimulation(ctx, { label: "reroll-timing", iterations: 60 });
      const hitRate = 5 / 6; // BS2+, nat1 auto-fails
      const correctWoundRate = 4 / 6;
      const buggyWoundRate = 0.75;
      const expectedCorrect = 100000 * hitRate * correctWoundRate;
      const expectedBuggy = 100000 * hitRate * buggyWoundRate;
      // Within 10% of the correct value...
      expect(result.meanDamage).toBeGreaterThan(expectedCorrect * 0.9);
      expect(result.meanDamage).toBeLessThan(expectedCorrect * 1.1);
      // ...and clearly below the (higher) buggy value, not just close to it.
      expect(result.meanDamage).toBeLessThan(expectedBuggy * 0.95);
    });

    it("reroll-all-failed-wounds (Sanctity of Purpose near objective) has the same fix applied", () => {
      const weapon = makeWeapon({ attacks: 100000, skill: 2, strength: 9 }); // S9vT5 = 3+, no twin-linked
      const target = makeTarget({ save: 7, toughness: 5, wounds: 10_000_000, count: 1 });
      const ctx = baseCtx({ weapon, target, woundMod: -1 });
      const result = runSimulation(ctx, {
        label: "reroll-all-timing",
        iterations: 60,
        rerolls: { woundRerollAllFailed: true },
      });
      const hitRate = 5 / 6;
      const correctWoundRate = 4 / 6; // identical math to the twin-linked case above
      const buggyWoundRate = 0.75;
      const expectedCorrect = 100000 * hitRate * correctWoundRate;
      const expectedBuggy = 100000 * hitRate * buggyWoundRate;
      expect(result.meanDamage).toBeGreaterThan(expectedCorrect * 0.9);
      expect(result.meanDamage).toBeLessThan(expectedCorrect * 1.1);
      expect(result.meanDamage).toBeLessThan(expectedBuggy * 0.95);
    });

    it("plain re-roll-wound-1s is unaffected by the fix (it was already correct — gated on the raw roll value directly)", () => {
      const weapon = makeWeapon({ attacks: 100000, skill: 2, strength: 4 }); // S4vT4 = 4+ = 3/6 base
      const target = makeTarget({ save: 7, toughness: 4, wounds: 10_000_000, count: 1 });
      const ctx = baseCtx({ weapon, target });
      const result = runSimulation(ctx, {
        label: "reroll-ones-unaffected",
        iterations: 100,
        rerolls: { woundRerollOnes: true },
      });
      // 4+ base (3/6), reroll only a natural 1: 3/6 + (1/6)(3/6) = 3/6 + 1/12 = 7/12 ≈ 0.583.
      const hitRate = 5 / 6;
      const expected = 100000 * hitRate * (7 / 12);
      expect(result.meanDamage).toBeGreaterThan(expected * 0.9);
      expect(result.meanDamage).toBeLessThan(expected * 1.1);
    });
  });

  describe("cover (-1 to Hit for ranged attacks, 11e rule — was previously unwired entirely)", () => {
    it("a target in cover reduces the attacker's hit roll by 1", () => {
      const weapon = makeWeapon({ attacks: 100000, skill: 3 }); // BS3+ = 4/6 base
      const targetNoCover = makeTarget({ save: 7, wounds: 10_000_000, count: 1 });
      const targetInCover: TargetUnit = { ...targetNoCover, hasCover: true };
      const rNoCover = runSimulation(baseCtx({ weapon, target: targetNoCover }), {
        label: "cover-off",
        iterations: 60,
      });
      const rInCover = runSimulation(baseCtx({ weapon, target: targetInCover, hitMod: -1 }), {
        label: "cover-on",
        iterations: 60,
      });
      // 3+ (4/6) -> effectively 4+ (3/6): ratio should be ~0.75.
      const ratio = rInCover.meanDamage / rNoCover.meanDamage;
      expect(ratio).toBeGreaterThan(0.65);
      expect(ratio).toBeLessThan(0.85);
    });

    it("cover never turns a natural 1 into a hit, and never stops a natural 6 from hitting", () => {
      // BS2+ with -1 to hit still only needs a modified 2+, i.e. an unmodified
      // 3+ — natural 1 must still always miss regardless.
      const weapon = makeWeapon({ attacks: 100000, skill: 2 });
      const target = makeTarget({ save: 7, wounds: 10_000_000, count: 1 });
      const result = runSimulation(baseCtx({ weapon, target, hitMod: -1 }), {
        label: "cover-floor",
        iterations: 60,
      });
      // Modified-3+ needed (rolls 3,4,5 pass at BS2+ with -1) plus natural 6 always hits: {3,4,5,6} = 4/6.
      const expected = 100000 * (4 / 6) * (3 / 6); // x wound rate S4vT4=4+=3/6
      expect(result.meanDamage).toBeGreaterThan(expected * 0.9);
      expect(result.meanDamage).toBeLessThan(expected * 1.1);
    });
  });

  describe("attached Character exposure once the Bodyguard is wiped (was previously a bug: damage past the Bodyguard's wound pool was silently discarded, so the Character could never die without a Precision weapon)", () => {
    const attachedTarget: TargetUnit = {
      name: "Bodyguard + Character",
      isAttached: true,
      hasCover: false,
      modelCountForBlast: 2,
      keywords: [],
      groups: [
        { label: "Bodyguard", count: 1, toughness: 1, save: 7, wounds: 1 },
        { label: "Character", count: 1, toughness: 1, save: 7, wounds: 1, isAttachedCharacter: true },
      ],
    };
    // Massive overkill (20 attacks vs. a 2-wound total unit) at guaranteed-ish
    // hit/wound/no-save so the Bodyguard's single wound is spent almost
    // immediately and most of the damage has somewhere else to go.
    const weapon = makeWeapon({ attacks: 20, skill: 2, strength: 20, ap: 0, damage: 1 });

    it("lets damage carry over to kill the Character once the Bodyguard is dead (non-Precision, normal targeting)", () => {
      const result = runSimulation(baseCtx({ weapon, target: attachedTarget }), {
        label: "attached-exposure",
        iterations: 300,
      });
      // Before the fix this was exactly 0 in every iteration — normal damage
      // only ever looked at nonCharPools, so once the Bodyguard died the rest
      // of that phase's damage vanished instead of reaching the Character.
      expect(result.killProbability).toBeGreaterThan(0.8);
    });

    it("still protects the Character while the Bodyguard has models remaining", () => {
      const twoBodyguards: TargetUnit = {
        ...attachedTarget,
        modelCountForBlast: 3,
        groups: [
          { label: "Bodyguard", count: 2, toughness: 1, save: 7, wounds: 1 },
          { label: "Character", count: 1, toughness: 1, save: 7, wounds: 1, isAttachedCharacter: true },
        ],
      };
      // A single attack (one wound at most) can never reach past a 2-model
      // Bodyguard to the Character — this should stay exactly as before.
      const oneShotWeapon = makeWeapon({ attacks: 1, skill: 2, strength: 20, ap: 0, damage: 1 });
      const result = runSimulation(baseCtx({ weapon: oneShotWeapon, target: twoBodyguards }), {
        label: "attached-still-protected",
        iterations: 300,
      });
      expect(result.killProbability).toBe(0);
    });
  });
});
