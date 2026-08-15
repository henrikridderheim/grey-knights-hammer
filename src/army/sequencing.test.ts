import { describe, it, expect } from "vitest";
import { computeOptimalSequencing } from "./sequencing";
import { ROSTER } from "./roster";
import { unitScenarios, buildEngagementsForScenario, DEFAULT_DAMAGE_SETTINGS } from "./engagementBuilder";
import type { TargetUnit, WeaponProfile } from "../engine/types";
import type { WeaponEngagement } from "./engagementBuilder";

function makeWeapon(overrides: Partial<WeaponProfile> = {}): WeaponProfile {
  return {
    name: "Test Weapon",
    isMelee: false,
    range: 24,
    attacks: 1,
    skill: 2,
    strength: 10,
    ap: 0,
    damage: 1,
    keywords: {},
    ...overrides,
  };
}

function makeEngagement(label: string, weapon: WeaponProfile, target: TargetUnit): WeaponEngagement {
  return {
    weaponLabel: label,
    ctx: {
      numAttackingModels: 1,
      weapon,
      target,
      halfRange: false,
      hitMod: 0,
      woundMod: 0,
      strengthBonus: 0,
    },
  };
}

describe("computeOptimalSequencing", () => {
  // 3 identical models, W3 each — verified directly against this module: a
  // 1-attack/6-damage "Big" weapon fired first (into a fresh model) beats
  // firing it second (into whatever the 3-attack/1-damage "Chip" weapon left
  // behind) by a large, real margin (~4.2 vs ~3.4 mean damage) — this is the
  // concrete case that caught the models-killed-vs-damage primary-sort bug
  // during development.
  const target: TargetUnit = {
    name: "t",
    isAttached: false,
    hasCover: false,
    modelCountForBlast: 3,
    keywords: [],
    groups: [{ label: "x", count: 3, toughness: 1, save: 7, wounds: 3 }],
  };
  const big = makeEngagement("Big", makeWeapon({ name: "Big", attacks: 1, damage: 6 }), target);
  const chip = makeEngagement("Chip", makeWeapon({ name: "Chip", attacks: 3, damage: 1 }), target);

  it("finds that firing the high-damage/low-volume weapon first beats firing it last", () => {
    // Naive/input order is Chip-then-Big (the worse order).
    const result = computeOptimalSequencing([chip, big]);
    expect(result.applicable).toBe(true);
    expect(result.optimalOrder).toEqual(["Big", "Chip"]);
    expect(result.optimalMeanDamage).toBeGreaterThan(result.naiveMeanDamage);
    // Concretely, not just "greater than" — should be a large, real gap, not noise.
    expect(result.optimalMeanDamage / result.naiveMeanDamage).toBeGreaterThan(1.1);
  });

  it("is order-invariant in what it reports as naive vs optimal — feeding the already-good order in first changes nothing", () => {
    const result = computeOptimalSequencing([big, chip]);
    expect(result.optimalOrder).toEqual(["Big", "Chip"]);
    expect(result.naiveOrder).toEqual(["Big", "Chip"]);
    // Already-optimal input order: naive and optimal should coincide.
    expect(result.optimalMeanDamage).toBeCloseTo(result.naiveMeanDamage, 0);
  });

  it("the optimal order's score is never worse than the naive order's (by construction, since naive is one of the evaluated permutations)", () => {
    for (const input of [
      [chip, big],
      [big, chip],
    ]) {
      const result = computeOptimalSequencing(input);
      expect(result.optimalMeanDamage).toBeGreaterThanOrEqual(result.naiveMeanDamage);
    }
  });

  it("reports not applicable for a single weapon profile — nothing to sequence", () => {
    const result = computeOptimalSequencing([big]);
    expect(result.applicable).toBe(false);
    expect(result.optimalOrder).toEqual(["Big"]);
  });

  it("reports not applicable for zero weapon profiles", () => {
    const result = computeOptimalSequencing([]);
    expect(result.applicable).toBe(false);
    expect(result.optimalOrder).toEqual([]);
  });

  it("merges identical weapon profiles fired by different loadouts before searching (Purifier Squad's 3 separate 'Purifying Flame' loadout entries collapse to 1)", () => {
    const purifierSquad = ROSTER.find((u) => u.id === "purifier-squad")!;
    const scenario = unitScenarios(purifierSquad, DEFAULT_DAMAGE_SETTINGS).find(
      (s) => s.mode === "shooting" && s.scenario.halfRange
    )!;
    const engagements = buildEngagementsForScenario(purifierSquad, target, "shooting", scenario.scenario);
    // Raw: Crowe (Purifying Flame, Storm bolter) + Knight of the Flame+5 Purifiers
    // (Purifying Flame, Storm bolter) + 4 Purifiers (Purifying Flame, Psycannon) = 6 engagements,
    // but only 3 distinct weapon profiles (Purifying Flame, Storm bolter, Psycannon).
    expect(engagements.length).toBe(6);
    const result = computeOptimalSequencing(engagements);
    expect(result.applicable).toBe(true);
    // Purifying Flame and Storm bolter each appear in >1 loadout, so they merge
    // down to their bare weapon name; Psycannon appears in only one loadout, so
    // it keeps its original full (loadout-qualified) label.
    expect(result.optimalOrder.length).toBe(3);
    expect(new Set(result.optimalOrder)).toEqual(
      new Set(["Purifying Flame", "Storm bolter", "Psycannon (4 Purifiers (psycannon))"])
    );
  });

  it("real GMND (3 weapons) against a small-wound-per-model target: exhaustive search, no greedy fallback", () => {
    const gmnd = ROSTER.find((u) => u.id === "gmnd-2")!;
    const termiTarget: TargetUnit = {
      name: "Terminator Squad",
      isAttached: false,
      hasCover: false,
      modelCountForBlast: 10,
      keywords: ["INFANTRY"],
      groups: [{ label: "x", count: 10, toughness: 5, save: 2, invulnSave: 4, wounds: 3 }],
    };
    const scenario = unitScenarios(gmnd, DEFAULT_DAMAGE_SETTINGS).find(
      (s) => s.mode === "shooting" && s.scenario.halfRange
    )!;
    const engagements = buildEngagementsForScenario(gmnd, termiTarget, "shooting", scenario.scenario);
    const result = computeOptimalSequencing(engagements);
    expect(result.applicable).toBe(true);
    expect(result.usedGreedyFallback).toBe(false);
    expect(result.permutationsEvaluated).toBe(6); // 3! for 3 distinct weapons
    expect(result.optimalOrder.length).toBe(3);
    expect(result.optimalMeanDamage).toBeGreaterThanOrEqual(result.naiveMeanDamage);
  });
});
