import { describe, it, expect } from "vitest";
import { computeBestWayToKillIt } from "./bestWayToKillIt";
import { DEFAULT_DAMAGE_SETTINGS } from "./engagementBuilder";
import type { TargetUnit } from "../engine/types";

describe("per-weapon 'Damage Dealt' breakdown vs. Models Slain capping", () => {
  // Real Terminator Squad profile: T5, Sv2+, Inv4+, W3/model, 10 models — a
  // 3-wound model can never absorb a Melta-boosted Sublimator hit (D6+4,
  // always 5-10) in full, so this is exactly the case the fix targets.
  const target: TargetUnit = {
    name: "Terminator Squad",
    isAttached: false,
    hasCover: false,
    modelCountForBlast: 10,
    keywords: ["INFANTRY"],
    groups: [{ label: "x", count: 10, toughness: 5, save: 2, invulnSave: 4, wounds: 3 }],
  };

  it("shows the weapon's raw uncapped damage in the breakdown, not the per-model-capped amount", () => {
    const result = computeBestWayToKillIt(target, { getUnitSettings: () => DEFAULT_DAMAGE_SETTINGS });
    const option = result.singles.find(
      (o) => o.unitId === "gmnd-1" && o.mode === "shooting" && o.scenarioLabel === "half range"
    )!;
    const sublimator = option.damageByWeapon.find((w) => w.label.includes("Sublimator"))!;
    // Uncapped expected value is roughly (unsaved wound rate) * mean(D6+4) = ~0.6-0.8 * 7.5 ≈ 4.5-6.
    // The old, wrongly-capped figure was ~1.9 (each unsaved wound clamped to the model's 3 wounds).
    expect(sublimator.avg).toBeGreaterThan(3.5);
    expect(sublimator.avg).toBeLessThan(7);
  });

  it("leaves a weapon whose damage never exceeded the target's wounds unaffected (Heavy psycannon, flat 3 dmg vs W3)", () => {
    const result = computeBestWayToKillIt(target, { getUnitSettings: () => DEFAULT_DAMAGE_SETTINGS });
    const option = result.singles.find(
      (o) => o.unitId === "gmnd-1" && o.mode === "shooting" && o.scenarioLabel === "half range"
    )!;
    const heavyPsycannon = option.damageByWeapon.find((w) => w.label.includes("Heavy psycannon"))!;
    // Flat Damage 3 against a 3-wound model is never actually capped, so this
    // should land at its ordinary (uncapped == capped) expected value.
    expect(heavyPsycannon.avg).toBeGreaterThan(3.5);
    expect(heavyPsycannon.avg).toBeLessThan(6.5);
  });

  it("does not change the combined summary's meanDamage or meanModelsKilled (kill-count math stays capped)", () => {
    const result = computeBestWayToKillIt(target, { getUnitSettings: () => DEFAULT_DAMAGE_SETTINGS });
    const option = result.singles.find(
      (o) => o.unitId === "gmnd-1" && o.mode === "shooting" && o.scenarioLabel === "half range"
    )!;
    // The combined multi-weapon total must stay realistic/capped — nowhere
    // near the sum of the (now-uncapped) solo weapon figures.
    const soloSum = option.damageByWeapon.reduce((sum, w) => sum + w.avg, 0);
    expect(option.summary.meanDamage).toBeLessThan(soloSum);
    expect(option.summary.meanModelsKilled).toBeGreaterThan(0);
    expect(option.summary.meanModelsKilled).toBeLessThan(10);
  });
});
