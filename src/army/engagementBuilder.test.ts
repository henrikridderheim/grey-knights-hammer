import { describe, it, expect } from "vitest";
import { ROSTER } from "./roster";
import {
  buildMeleeEngagements,
  buildShootingEngagements,
  unitScenarios,
  DEFAULT_DAMAGE_SETTINGS,
  type ScenarioFlags,
} from "./engagementBuilder";
import type { TargetUnit } from "../engine/types";

const target: TargetUnit = {
  name: "dummy",
  isAttached: false,
  hasCover: false,
  modelCountForBlast: 1,
  keywords: ["INFANTRY"],
  groups: [{ label: "x", count: 1, toughness: 4, save: 3, wounds: 2 }],
};

const baseScenario: ScenarioFlags = {
  halfRange: false,
  deepStruck: false,
  purgationPatternActive: false,
  focusedImmolationActive: false,
  truesilverChannellingActive: false,
  nearObjective: false,
};

describe("Sanctity of Purpose (Purifier Squad)", () => {
  const purifierSquad = ROSTER.find((u) => u.id === "purifier-squad")!;
  const purgationSquad = ROSTER.find((u) => u.id === "purgation-squad-a")!;

  it("applies the baseline re-roll-wound-1s to Purifier Squad's melee attacks, not just shooting", () => {
    const meleeEngagements = buildMeleeEngagements(purifierSquad, target, baseScenario);
    expect(meleeEngagements.length).toBeGreaterThan(0);
    for (const e of meleeEngagements) {
      expect(e.rerolls?.woundRerollOnes).toBe(true);
    }
  });

  it("upgrades to re-roll all failed wounds in melee when near an objective", () => {
    const nearObjective = buildMeleeEngagements(purifierSquad, target, { ...baseScenario, nearObjective: true });
    for (const e of nearObjective) {
      expect(e.rerolls?.woundRerollAllFailed).toBe(true);
    }
  });

  it("does not grant Sanctity of Purpose rerolls to a unit that doesn't have the ability", () => {
    const meleeEngagements = buildMeleeEngagements(purgationSquad, target, baseScenario);
    for (const e of meleeEngagements) {
      expect(e.rerolls?.woundRerollOnes).not.toBe(true);
    }
  });

  it("still applies in shooting too (regression guard against re-breaking the other phase)", () => {
    const shootingEngagements = buildShootingEngagements(purifierSquad, target, baseScenario);
    for (const e of shootingEngagements) {
      expect(e.rerolls?.woundRerollOnes).toBe(true);
    }
  });
});

describe("cover (-1 to Hit, ranged only) — was previously unwired: hitMod was hardcoded to 0 everywhere", () => {
  const gmnd = ROSTER.find((u) => u.id === "gmnd-2")!;
  const targetInCover: TargetUnit = { ...target, hasCover: true };

  it("applies -1 hitMod to a ranged weapon without [IGNORES COVER] when the target has cover", () => {
    const engagements = buildShootingEngagements(gmnd, targetInCover, baseScenario);
    const fragstorm = engagements.find((e) => e.weaponLabel.includes("Fragstorm"))!;
    expect(fragstorm.ctx.hitMod).toBe(-1);
  });

  it("does not apply the penalty to a weapon with [IGNORES COVER] (Heavy psycannon)", () => {
    const engagements = buildShootingEngagements(gmnd, targetInCover, baseScenario);
    const heavyPsycannon = engagements.find((e) => e.weaponLabel.includes("Heavy psycannon"))!;
    expect(heavyPsycannon.ctx.hitMod).toBe(0);
  });

  it("applies no penalty at all when the target has no cover", () => {
    const engagements = buildShootingEngagements(gmnd, target, baseScenario);
    for (const e of engagements) {
      expect(e.ctx.hitMod).toBe(0);
    }
  });

  it("never applies to melee — cover only affects ranged attacks in 11e", () => {
    const engagements = buildMeleeEngagements(gmnd, targetInCover, baseScenario);
    expect(engagements.length).toBeGreaterThan(0);
    for (const e of engagements) {
      expect(e.ctx.hitMod).toBe(0);
    }
  });
});

describe("unitScenarios half-range override", () => {
  // A range-sensitive unit (Rapid Fire / Melta) auto-enumerates two shooting
  // scenarios (half + full band); the manual override collapses that to one.
  const rangeSensitiveUnit = ROSTER.find(
    (u) => unitScenarios(u, DEFAULT_DAMAGE_SETTINGS).filter((s) => s.mode === "shooting").length === 2
  )!;

  it("auto-enumerates both half and full range when no override is given", () => {
    expect(rangeSensitiveUnit).toBeDefined();
    const shooting = unitScenarios(rangeSensitiveUnit, DEFAULT_DAMAGE_SETTINGS).filter((s) => s.mode === "shooting");
    expect(shooting.map((s) => s.scenario.halfRange).sort()).toEqual([false, true]);
  });

  it("collapses to a single half-range scenario when override = true", () => {
    const shooting = unitScenarios(rangeSensitiveUnit, DEFAULT_DAMAGE_SETTINGS, true).filter((s) => s.mode === "shooting");
    expect(shooting).toHaveLength(1);
    expect(shooting[0].scenario.halfRange).toBe(true);
  });

  it("collapses to a single full-range scenario when override = false", () => {
    const shooting = unitScenarios(rangeSensitiveUnit, DEFAULT_DAMAGE_SETTINGS, false).filter((s) => s.mode === "shooting");
    expect(shooting).toHaveLength(1);
    expect(shooting[0].scenario.halfRange).toBe(false);
  });

  it("never forces half range on a unit with no Rapid Fire / Melta weapon", () => {
    const plainRangedUnit = ROSTER.find(
      (u) =>
        u.loadouts.some((l) => l.rangedWeapons.length > 0) &&
        unitScenarios(u, DEFAULT_DAMAGE_SETTINGS).filter((s) => s.mode === "shooting").length === 1
    );
    if (!plainRangedUnit) return; // roster has none; nothing to assert
    const shooting = unitScenarios(plainRangedUnit, DEFAULT_DAMAGE_SETTINGS, true).filter((s) => s.mode === "shooting");
    expect(shooting).toHaveLength(1);
    expect(shooting[0].scenario.halfRange).toBe(false);
  });
});

describe("target defensive toggles (-1 Wound / -1 Damage / -1 AP)", () => {
  const gmnd = ROSTER.find((u) => u.id === "gmnd-2")!;

  it("does nothing when the target has no defensiveSettings", () => {
    for (const e of buildShootingEngagements(gmnd, target, baseScenario)) {
      expect(e.ctx.woundMod).toBe(0);
      expect(e.ctx.apReduction ?? 0).toBe(0);
      expect(e.ctx.damageReduction ?? 0).toBe(0);
    }
  });

  it("threads -1 to Wound into ctx.woundMod for both shooting and melee", () => {
    const debuffed: TargetUnit = { ...target, defensiveSettings: { minusOneToWound: true, minusOneToDamage: false, minusOneToAP: false } };
    for (const e of buildShootingEngagements(gmnd, debuffed, baseScenario)) {
      expect(e.ctx.woundMod).toBe(-1);
    }
    for (const e of buildMeleeEngagements(gmnd, debuffed, baseScenario)) {
      expect(e.ctx.woundMod).toBe(-1);
    }
  });

  it("threads -1 to Damage into ctx.damageReduction for both shooting and melee", () => {
    const debuffed: TargetUnit = { ...target, defensiveSettings: { minusOneToWound: false, minusOneToDamage: true, minusOneToAP: false } };
    for (const e of buildShootingEngagements(gmnd, debuffed, baseScenario)) {
      expect(e.ctx.damageReduction).toBe(1);
    }
    for (const e of buildMeleeEngagements(gmnd, debuffed, baseScenario)) {
      expect(e.ctx.damageReduction).toBe(1);
    }
  });

  it("threads -1 to AP into ctx.apReduction for both shooting and melee", () => {
    const debuffed: TargetUnit = { ...target, defensiveSettings: { minusOneToWound: false, minusOneToDamage: false, minusOneToAP: true } };
    for (const e of buildShootingEngagements(gmnd, debuffed, baseScenario)) {
      expect(e.ctx.apReduction).toBe(1);
    }
    for (const e of buildMeleeEngagements(gmnd, debuffed, baseScenario)) {
      expect(e.ctx.apReduction).toBe(1);
    }
  });

  it("stacks all three at once", () => {
    const debuffed: TargetUnit = { ...target, defensiveSettings: { minusOneToWound: true, minusOneToDamage: true, minusOneToAP: true } };
    for (const e of buildShootingEngagements(gmnd, debuffed, baseScenario)) {
      expect(e.ctx.woundMod).toBe(-1);
      expect(e.ctx.damageReduction).toBe(1);
      expect(e.ctx.apReduction).toBe(1);
    }
  });
});
