import { describe, it, expect } from "vitest";
import {
  normalizedWeaponToProfile,
  rosterUnitToTarget,
  isDreadClass,
  computeThreatAnalysis,
} from "./threatAnalysis";
import { ROSTER, type UnitDefinition } from "./roster";
import type { NormalizedUnit, NormalizedWeapon } from "../parser/types";
import type { ParseArmyListResult, ParsedUnit } from "../parser/parseArmyList";

function weapon(partial: Partial<NormalizedWeapon> & { name: string }): NormalizedWeapon {
  return {
    isMelee: false,
    range: 24,
    attacks: 1,
    skill: 3,
    strength: 4,
    ap: 0,
    damage: 1,
    keywords: {},
    rawKeywords: [],
    ...partial,
  };
}

function datasheet(name: string, weapons: NormalizedWeapon[]): NormalizedUnit {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    faction: "Test",
    factionKeyword: "TEST",
    points: 100,
    composition: "5 models",
    statline: { move: "6\"", toughness: 4, save: 4, wounds: 1, leadership: "7+", oc: 1 },
    keywords: ["INFANTRY"],
    weapons,
    abilities: [],
    isCharacter: false,
    canLead: [],
  };
}

function parsedUnit(rawName: string, ds: NormalizedUnit, wargear: { name: string; count: number }[]): ParsedUnit {
  return {
    rawName,
    points: ds.points,
    modelCount: null,
    matchedUnitId: ds.id,
    matchedUnitName: ds.name,
    datasheet: ds,
    wargear: wargear.map((w) => ({ rawText: `${w.count}x ${w.name}`, count: w.count, matchedWeaponName: w.name })),
    isWarlord: false,
    enhancement: null,
    attachedRole: null,
    attachedGroupIndex: null,
  };
}

function listOf(units: ParsedUnit[]): ParseArmyListResult {
  return { faction: "Test", detachment: null, units, attachedGroups: [], unresolved: [], totalPoints: null };
}

function attachedListOf(members: ParsedUnit[]): ParseArmyListResult {
  const withIndex = members.map((m) => ({ ...m, attachedGroupIndex: 1 }));
  return {
    faction: "Test",
    detachment: null,
    units: withIndex,
    attachedGroups: [{ index: 1, members: withIndex }],
    unresolved: [],
    totalPoints: null,
  };
}

describe("normalizedWeaponToProfile", () => {
  it("copies core characteristics through unchanged", () => {
    const p = normalizedWeaponToProfile(weapon({ name: "Bolt rifle", strength: 4, ap: 1, damage: 1, skill: 3 }));
    expect(p).toMatchObject({ name: "Bolt rifle", strength: 4, ap: 1, damage: 1, skill: 3, isMelee: false });
  });

  it("coerces a die-string Sustained Hits to a flat average", () => {
    const p = normalizedWeaponToProfile(weapon({ name: "Blastgun", keywords: { sustainedHits: "D3" } }));
    expect(p.keywords.sustainedHits).toBe(2);
  });

  it("passes numeric keywords and Anti-X through", () => {
    const p = normalizedWeaponToProfile(
      weapon({ name: "Melta", keywords: { melta: 2, antiKeyword: "MONSTER", antiThreshold: 4, devastatingWounds: true } })
    );
    expect(p.keywords.melta).toBe(2);
    expect(p.keywords.antiKeyword).toBe("MONSTER");
    expect(p.keywords.antiThreshold).toBe(4);
    expect(p.keywords.devastatingWounds).toBe(true);
  });
});

describe("roster target + bucket classification", () => {
  it("builds a target sized by total models across loadouts", () => {
    const strike = (ROSTER as UnitDefinition[]).find((u) => u.id === "strike-squad-1")!;
    const target = rosterUnitToTarget(strike);
    const models = target.groups.reduce((s, g) => s + g.count, 0);
    expect(models).toBe(strike.loadouts.reduce((s, l) => s + l.count, 0));
  });

  it("classifies Dreadknights (MONSTER, high toughness) as dread-class and squads as infantry", () => {
    const dread = (ROSTER as UnitDefinition[]).find((u) => u.id === "gmnd-2")!;
    const strike = (ROSTER as UnitDefinition[]).find((u) => u.id === "strike-squad-1")!;
    expect(isDreadClass(dread)).toBe(true);
    expect(isDreadClass(strike)).toBe(false);
  });
});

describe("computeThreatAnalysis", () => {
  it("classifies a heavy anti-tank unit as anti-Dreadknight (most effective there)", () => {
    // 5 lascannons: full damage into a Dreadknight, wasteful overkill into 1-2W models.
    const lascannons = datasheet("Devastators", [
      weapon({ name: "Lascannon", range: 48, attacks: 1, skill: 3, strength: 12, ap: 3, damage: { dice: "D6", flat: 1 } }),
    ]);
    const list = listOf([parsedUnit("Devastators", lascannons, [{ name: "Lascannon", count: 5 }])]);

    const result = computeThreatAnalysis(list);
    expect(result.topThreats.length).toBeGreaterThan(0);
    const devs = result.profiles.find((p) => p.attackerName === "Devastators")!;
    expect(devs.specialty).toBe("dreadknight");
    // Effective damage into the Dreadknight should beat that into light infantry.
    const intoDread = devs.matchups.find((m) => m.key === "dreadknight")!;
    const intoLight = devs.matchups.find((m) => m.key === "light")!;
    expect(intoDread.meanDamage).toBeGreaterThan(intoLight.meanDamage);
    expect(result.verdict.leaning).toBe("dreadknight");
  });

  it("classifies a high-volume anti-infantry unit as anti-light-infantry", () => {
    // 40 rapid-fire S4 shots: shreds light infantry, does little to a Dreadknight.
    const shooters = datasheet("Gunline", [
      weapon({ name: "Rifle", range: 24, attacks: 1, skill: 3, strength: 4, ap: 0, damage: 1, keywords: { rapidFire: 1 } }),
    ]);
    const list = listOf([parsedUnit("Gunline", shooters, [{ name: "Rifle", count: 40 }])]);

    const result = computeThreatAnalysis(list);
    const mob = result.profiles.find((p) => p.attackerName === "Gunline")!;
    expect(mob.specialty).toBe("light");
    const intoLight = mob.matchups.find((m) => m.key === "light")!;
    const intoDread = mob.matchups.find((m) => m.key === "dreadknight")!;
    expect(intoLight.meanDamage).toBeGreaterThan(intoDread.meanDamage);
    expect(result.verdict.leaning).toBe("light");
  });

  it("evaluates each unit into all three archetypes independently", () => {
    const ds = datasheet("Bolter Squad", [
      weapon({ name: "Bolt rifle", range: 24, attacks: 2, skill: 3, strength: 4, ap: 1, damage: 1, keywords: { rapidFire: 1 } }),
    ]);
    const result = computeThreatAnalysis(listOf([parsedUnit("Bolter Squad", ds, [{ name: "Bolt rifle", count: 10 }])]));
    const profile = result.profiles[0];
    // One matchup per archetype rep the roster provides (dread + elite + light).
    expect(profile.matchups.map((m) => m.key).sort()).toEqual(["dreadknight", "elite", "light"]);
    expect(result.archetypes.length).toBe(3);
  });

  it("collapses a group whose members were duplicated (A+B+A+B) into one A+B, not double firepower", () => {
    const leader = datasheet("Fabius Bile", [
      weapon({ name: "Pistol", range: 12, attacks: 1, skill: 2, strength: 4, ap: 1, damage: 1 }),
    ]);
    const squad = datasheet("Legionaries", [
      weapon({ name: "Bolt rifle", range: 24, attacks: 2, skill: 3, strength: 4, ap: 1, damage: 1 }),
    ]);
    // The parser lumped two copies of the same attached unit into one group.
    const dup = attachedListOf([
      parsedUnit("Fabius Bile", leader, [{ name: "Pistol", count: 1 }]),
      parsedUnit("Legionaries", squad, [{ name: "Bolt rifle", count: 10 }]),
      parsedUnit("Fabius Bile", leader, [{ name: "Pistol", count: 1 }]),
      parsedUnit("Legionaries", squad, [{ name: "Bolt rifle", count: 10 }]),
    ]);
    const dupResult = computeThreatAnalysis(dup);
    expect(dupResult.profiles).toHaveLength(1);
    expect(dupResult.profiles[0].attackerName).toBe("Fabius Bile + Legionaries");

    // Its output must match a SINGLE (non-duplicated) copy of the same unit.
    const single = attachedListOf([
      parsedUnit("Fabius Bile", leader, [{ name: "Pistol", count: 1 }]),
      parsedUnit("Legionaries", squad, [{ name: "Bolt rifle", count: 10 }]),
    ]);
    const singleResult = computeThreatAnalysis(single);
    const dmgDup = dupResult.profiles[0].matchups.find((m) => m.key === "light")!.meanDamage;
    const dmgSingle = singleResult.profiles[0].matchups.find((m) => m.key === "light")!.meanDamage;
    // Within Monte-Carlo noise, not doubled.
    expect(Math.abs(dmgDup - dmgSingle)).toBeLessThan(dmgSingle * 0.2 + 0.5);
  });

  it("collapses identical repeated standalone units and reports multiplicity", () => {
    const ds = datasheet("Havocs", [
      weapon({ name: "Lascannon", range: 48, attacks: 1, skill: 3, strength: 12, ap: 3, damage: { dice: "D6", flat: 1 } }),
    ]);
    const list = listOf([
      parsedUnit("Havocs", ds, [{ name: "Lascannon", count: 4 }]),
      parsedUnit("Havocs", ds, [{ name: "Lascannon", count: 4 }]),
    ]);
    const result = computeThreatAnalysis(list);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].multiplicity).toBe(2);
  });

  it("skips units with no matched weapons rather than crashing", () => {
    const ds = datasheet("Objective Holders", []);
    const unit = parsedUnit("Objective Holders", ds, []);
    const result = computeThreatAnalysis(listOf([unit]));
    expect(result.skipped).toContain("Objective Holders");
    expect(result.topThreats.length).toBe(0);
  });
});
