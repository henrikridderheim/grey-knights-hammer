import { describe, it, expect, afterEach } from "vitest";
import {
  hasRuggedResilience,
  stormShieldInfo,
  buildDefenseGroups,
  detectDefensiveAbilities,
  buildUnitDefense,
  setSharedAbilityPool,
} from "./opponentDefenses";

// The shared-ability pool is module-global; reset it so tests don't leak.
afterEach(() => setSharedAbilityPool([]));
import type { NormalizedUnit, NormalizedAbility } from "../parser/types";
import type { ParsedWargearLine } from "./../parser/parseArmyList";

function sheet(overrides: Partial<NormalizedUnit> = {}): NormalizedUnit {
  return {
    id: "wgt",
    name: "Wolf Guard Terminators",
    faction: "Space Wolves",
    factionKeyword: "Space Wolves",
    points: 170,
    composition: "5 models",
    statline: { move: "6\"", toughness: 5, save: 2, invulnSave: 4, wounds: 3, leadership: "6+", oc: 1 },
    keywords: ["Infantry", "Terminator"],
    weapons: [],
    abilities: [
      { name: "Rugged Resilience", text: "Each time an attack targets this unit, if the Strength characteristic of that attack is greater than the Toughness characteristic of this unit, subtract 1 from the Wound roll." },
      { name: "Storm Shield", text: "The bearer has a Wounds characteristic of 4." },
    ],
    isCharacter: false,
    canLead: [],
    ...overrides,
  };
}

const wargear = (lines: { rawText: string; count: number }[]): ParsedWargearLine[] =>
  lines.map((l) => ({ rawText: l.rawText, count: l.count, matchedWeaponName: null }));

const withAbilities = (abilities: NormalizedAbility[]): NormalizedUnit => sheet({ abilities });
const ab = (name: string, text: string): NormalizedAbility => ({ name, text });

describe("hasRuggedResilience", () => {
  it("detects the ability by name", () => {
    expect(hasRuggedResilience(sheet())).toBe(true);
    expect(hasRuggedResilience(sheet({ abilities: [] }))).toBe(false);
  });
});

describe("stormShieldInfo", () => {
  it("reads the Wounds value from the ability text and the count from wargear", () => {
    const info = stormShieldInfo(sheet(), wargear([{ rawText: "Storm Shield", count: 4 }]));
    expect(info).toEqual({ shieldWounds: 4, count: 4 });
  });

  it("returns null when the unit has no shields listed", () => {
    expect(stormShieldInfo(sheet(), wargear([{ rawText: "Master-crafted power weapon", count: 4 }]))).toBeNull();
  });

  it("returns null when the datasheet has no Storm Shield ability", () => {
    expect(stormShieldInfo(sheet({ abilities: [] }), wargear([{ rawText: "Storm Shield", count: 4 }]))).toBeNull();
  });
});

describe("detectDefensiveAbilities", () => {
  const effectsOf = (u: NormalizedUnit) => detectDefensiveAbilities(u, []).detected.map((d) => d.effect.kind).sort();

  it("detects Feel No Pain N+ and reads the value", () => {
    const u = withAbilities([ab("Bloody-handed", "Each time an attack is allocated to this model, this model has Feel No Pain 5+.")]);
    const d = detectDefensiveAbilities(u, []).detected.find((x) => x.effect.kind === "feelNoPain")!;
    expect(d.effect).toEqual({ kind: "feelNoPain", value: 5 });
  });

  it("detects -1 to Hit (Stealth) and -1 Damage and unconditional -1 to Wound", () => {
    const stealth = withAbilities([ab("Stealth", "Each time a ranged attack targets this unit, subtract 1 from that attack's Hit roll.")]);
    expect(effectsOf(stealth)).toContain("hitPenalty");
    const dmg = withAbilities([ab("Duty and Honour", "Each time an attack is allocated to this model, subtract 1 from the Damage characteristic of that attack.")]);
    expect(effectsOf(dmg)).toContain("reduceDamage");
    const wnd = withAbilities([ab("Warp-forged", "Each time an attack is made against this unit, subtract 1 from the Wound roll.")]);
    expect(effectsOf(wnd)).toContain("woundPenalty");
  });

  it("classifies the conditional S>T wording as Rugged Resilience, not a flat -1 to wound", () => {
    const rugged = withAbilities([
      ab("Big and Tough", "Each time an attack targets this unit, if the Strength characteristic of that attack is greater than the Toughness characteristic of this unit, subtract 1 from the Wound roll."),
    ]);
    expect(effectsOf(rugged)).toContain("ruggedResilience");
    expect(effectsOf(rugged)).not.toContain("woundPenalty");
  });

  it("surfaces a defensive-looking ability it can't model in `unmodeled`", () => {
    const u = withAbilities([ab("Dispersed", "Each time an attack is allocated to this model, halve the Damage characteristic of that attack.")]);
    const { detected, unmodeled } = detectDefensiveAbilities(u, []);
    expect(detected.some((d) => d.effect.kind === "reduceDamage")).toBe(false);
    expect(unmodeled).toContain("Dispersed");
  });

  it("ignores abilities in the faction shared pool (the polluted per-unit list)", () => {
    // A stray FNP from an unrelated faction ability that shouldn't be this unit's.
    const u = withAbilities([
      ab("Rugged Resilience", "if the Strength characteristic of that attack is greater than the Toughness characteristic of this unit, subtract 1 from the Wound roll"),
      ab("Vengeance Before Death", "This model has the Feel No Pain 5+ ability."),
    ]);
    // Before filtering, both are seen.
    expect(detectDefensiveAbilities(u, []).detected.map((d) => d.effect.kind)).toContain("feelNoPain");
    // Mark the stray ability as shared → it's excluded; Rugged Resilience stays.
    setSharedAbilityPool(["Vengeance Before Death"]);
    const kinds = detectDefensiveAbilities(u, []).detected.map((d) => d.effect.kind);
    expect(kinds).toContain("ruggedResilience");
    expect(kinds).not.toContain("feelNoPain");
  });

  it("flags a Feel No Pain that only applies conditionally", () => {
    const u = withAbilities([ab("Sepulchral Guard", "Each time an attack is allocated to this model, this model has Feel No Pain 4+ against mortal wounds.")]);
    const d = detectDefensiveAbilities(u, []).detected.find((x) => x.effect.kind === "feelNoPain")!;
    expect(d.conditional).toBe(true);
  });
});

describe("buildUnitDefense", () => {
  it("applies FNP to the group and aggregates incoming modifiers, honoring disabled ids", () => {
    const u = withAbilities([
      ab("Stealth", "subtract 1 from that attack's Hit roll"),
      ab("Warded", "Feel No Pain 5+"),
    ]);
    const on = buildUnitDefense(u, "X", 5, [], new Set());
    expect(on.groups[0].feelNoPain).toBe(5);
    expect(on.incoming.hitPenalty).toBe(1);

    const fnpId = on.detected.find((d) => d.effect.kind === "feelNoPain")!.id;
    const off = buildUnitDefense(u, "X", 5, [], new Set([fnpId]));
    expect(off.groups[0].feelNoPain).toBeUndefined();
    expect(off.incoming.hitPenalty).toBe(1); // Stealth still on
  });
});

describe("buildDefenseGroups", () => {
  it("splits Storm-Shield bearers into a W4 sub-group (4x W4 + 1x W3 = 19 wounds)", () => {
    const groups = buildDefenseGroups(sheet(), "Wolf Guard Terminators", 5, wargear([{ rawText: "Storm Shield", count: 4 }]));
    const total = groups.reduce((s, g) => s + g.count * g.wounds, 0);
    expect(total).toBe(19);
    const shieldGroup = groups.find((g) => g.wounds === 4)!;
    expect(shieldGroup.count).toBe(4);
    const plain = groups.find((g) => g.wounds === 3)!;
    expect(plain.count).toBe(1);
  });

  it("leaves a unit without shields as a single base group", () => {
    const groups = buildDefenseGroups(sheet(), "WGT", 5, wargear([]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 5, wounds: 3 });
  });

  it("never lowers Wounds: a W5 model with the same ability text keeps W5", () => {
    const bigModel = sheet({ statline: { ...sheet().statline, wounds: 5 } });
    const groups = buildDefenseGroups(bigModel, "Battle Leader", 1, wargear([{ rawText: "Storm Shield", count: 1 }]));
    expect(groups).toHaveLength(1);
    expect(groups[0].wounds).toBe(5);
  });
});
