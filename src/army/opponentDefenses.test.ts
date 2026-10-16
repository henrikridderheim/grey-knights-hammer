import { describe, it, expect, afterEach } from "vitest";
import {
  hasRuggedResilience,
  stormShieldInfo,
  buildDefenseGroups,
  detectDefensiveAbilities,
  buildUnitDefense,
  setSharedAbilityPool,
  isOptionSelected,
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

describe("core abilities (Feel No Pain / Stealth from the datasheet's core-ability list)", () => {
  // Regression: the data sync used to drop core abilities entirely, so a
  // C'tan Shard's printed "Feel No Pain 5+" was never applied to anything.
  const ctan = (overrides: Partial<NormalizedUnit> = {}) =>
    sheet({
      id: "ctan-shard-of-the-void-dragon",
      name: "C'tan Shard of the Void Dragon",
      abilities: [ab("Necrodermis", "Each time an attack is allocated to this model, subtract 1 from the Damage characteristic of that attack.")],
      coreAbilities: ["Deadly Demise D6", "Deep Strike", "Feel No Pain 5+"],
      ...overrides,
    });

  it("detects a core Feel No Pain, unconditional, alongside Necrodermis", () => {
    const d = detectDefensiveAbilities(ctan(), []);
    const fnp = d.detected.find((x) => x.effect.kind === "feelNoPain");
    expect(fnp?.effect).toEqual({ kind: "feelNoPain", value: 5 });
    expect(fnp?.conditional).toBe(false);
    expect(fnp?.label).toMatch(/core ability/i);
    expect(d.detected.some((x) => x.effect.kind === "reduceDamage")).toBe(true);
  });

  it("applies the core Feel No Pain to the target's model groups", () => {
    const def = buildUnitDefense(ctan(), "C'tan", 1, [], new Set());
    expect(def.groups[0].feelNoPain).toBe(5);
    expect(def.incoming.damageReduction).toBe(1);
  });

  it("the user can switch it off like any other detected ability", () => {
    const id = detectDefensiveAbilities(ctan(), []).detected.find((x) => x.effect.kind === "feelNoPain")!.id;
    expect(buildUnitDefense(ctan(), "C'tan", 1, [], new Set([id])).groups[0].feelNoPain).toBeUndefined();
  });

  it("is not suppressed by the faction-wide shared-ability pool", () => {
    setSharedAbilityPool(["Necrodermis", "Feel No Pain 5+", "Feel No Pain"]);
    const fnp = detectDefensiveAbilities(ctan(), []).detected.find((x) => x.effect.kind === "feelNoPain");
    expect(fnp?.effect).toEqual({ kind: "feelNoPain", value: 5 });
  });

  it("detects core Stealth as a -1 to be hit", () => {
    const d = detectDefensiveAbilities(ctan({ coreAbilities: ["Stealth", "Deep Strike"] }), []);
    expect(d.detected.some((x) => x.effect.kind === "hitPenalty" && !x.conditional)).toBe(true);
    expect(buildUnitDefense(ctan({ coreAbilities: ["Stealth"] }), "x", 1, [], new Set()).incoming.hitPenalty).toBe(1);
  });

  it("a better unconditional Feel No Pain elsewhere beats the core value", () => {
    const u = ctan({ abilities: [ab("Warded", "The bearer has the Feel No Pain 4+ ability.")] });
    expect(buildUnitDefense(u, "x", 1, [], new Set()).groups[0].feelNoPain).toBe(4);
  });

  it("ignores core abilities that aren't defensive, and units with none", () => {
    expect(detectDefensiveAbilities(ctan({ abilities: [], coreAbilities: ["Deep Strike", "Deadly Demise D6"] }), []).detected).toHaveLength(0);
    expect(detectDefensiveAbilities(sheet({ abilities: [] }), []).detected).toHaveLength(0);
  });
});

describe("optional upgrades (enhancements / wargear options) only apply when the list takes them", () => {
  // Regression: the datasheet lists every option a player COULD take. A C'tan
  // Shard that didn't take Animus Damper still got its -1 hit / -1 wound, and
  // both Skorpekh Lords got Feel No Pain 4+ though only one took Enaegic Dermal Bond.
  const wg = (...names: string[]): ParsedWargearLine[] =>
    names.map((n) => ({ rawText: n, count: 1, matchedWeaponName: null }));
  const dermal = { ...ab("Enaegic Dermal Bond", "NECRONS model only. The bearer has the Feel No Pain 4+ ability."), options: ["Enaegic Dermal Bond"] };
  const lord = sheet({ id: "skorpekh-lord", name: "Skorpekh Lord", abilities: [dermal] });
  const fnpOf = (enh?: string | null, w: ParsedWargearLine[] = []) => buildUnitDefense(lord, "Lord", 1, w, new Set(), undefined, enh).groups[0].feelNoPain;

  it("is applied when it is the chosen enhancement (case/punctuation-insensitive)", () => {
    expect(fnpOf("Enaegic Dermal Bond")).toBe(4);
    expect(fnpOf("enaegic dermal-bond")).toBe(4);
  });

  it("is NOT applied when the unit has no enhancement, or a different one", () => {
    expect(fnpOf(null)).toBeUndefined();
    expect(fnpOf(undefined)).toBeUndefined();
    expect(fnpOf("Warrior Noble")).toBeUndefined();
  });

  it("an optional wargear ability applies only when that wargear line is present", () => {
    const damper = { ...ab("Animus Damper", "Each time an attack targets this unit, subtract 1 from the Hit roll."), options: ["Animus Damper"] };
    const u = sheet({ abilities: [damper] });
    expect(detectDefensiveAbilities(u, wg("Spear of the Void Dragon"), null).detected).toHaveLength(0);
    expect(detectDefensiveAbilities(u, wg("Animus Damper"), null).detected).toHaveLength(1);
  });

  it("an ability with no `options` is the unit's own and always applies", () => {
    const own = ab("Necrodermis", "Each time an attack is allocated to this model, subtract 1 from the Damage characteristic of that attack.");
    expect(detectDefensiveAbilities(sheet({ abilities: [own] }), [], null).detected).toHaveLength(1);
  });

  it("an ability provided by several upgrades applies if any one is taken", () => {
    const a = { ...ab("Veil", "The bearer has the Feel No Pain 5+ ability."), options: ["Veil A", "Veil B"] };
    expect(detectDefensiveAbilities(sheet({ abilities: [a] }), [], "Veil B").detected).toHaveLength(1);
    expect(detectDefensiveAbilities(sheet({ abilities: [a] }), [], "Veil C").detected).toHaveLength(0);
  });

  it("isOptionSelected: wargear lines may carry a suffix such as (Aura); short names don't false-match", () => {
    expect(isOptionSelected(["Nullstone field generator"], wg("Nullstone Field Generator (Aura)"))).toBe(true);
    expect(isOptionSelected(["Animus Damper"], wg("Spear of the Void Dragon"))).toBe(false);
    expect(isOptionSelected(["Spear of the Void Dragon"], wg("Spear"))).toBe(false); // too short to trust
    expect(isOptionSelected([], wg("Anything"), "Anything")).toBe(false);
  });
});

describe("offensive-only hit/wound penalties are NOT treated as defences", () => {
  // Regression: the C'tan Shard of the Void Dragon showed a "-1 to be wounded" /
  // "-1 to be hit" toggle that isn't on its datasheet. Both came from Animus
  // Damper, which debuffs a selected enemy Vehicle's attacks.
  const animusDamper = ab(
    "Animus Damper",
    "Once per turn, at the start of your opponent’s Shooting phase, select one enemy Vehicle unit visible to the bearer. That unit must take a Leadership test. Until the end of the phase, each time a model in that unit makes an attack, subtract 1 from the Hit roll and, if that Leadership test was failed, subtract 1 from the Wound roll as well."
  );
  const damaged = ab("Damaged: 1-4 wounds remaining", "While this model has 1-4 wounds remaining, each time this model makes an attack, subtract 1 from the Hit roll.");

  it("Animus Damper yields no -1 to be hit and no -1 to be wounded, and isn't listed as unmodelled", () => {
    const d = detectDefensiveAbilities(withAbilities([animusDamper]), []);
    expect(d.detected).toHaveLength(0);
    expect(d.unmodeled).toHaveLength(0);
    const def = buildUnitDefense(withAbilities([animusDamper]), "x", 1, [], new Set());
    expect(def.incoming).toEqual({ hitPenalty: 0, woundPenalty: 0, damageReduction: 0 });
  });

  it("a model's own 'Damaged' attack penalty is not a defence", () => {
    const d = detectDefensiveAbilities(withAbilities([damaged]), []);
    expect(d.detected).toHaveLength(0);
    expect(d.unmodeled).toHaveLength(0);
  });

  it("still detects real defensive wording, including when the text also mentions the unit's own attacks", () => {
    const both = ab("Warded Advance", "Each time a ranged attack targets this unit, subtract 1 from the Hit roll. Each time this model makes an attack, add 1 to the Hit roll.");
    expect(effectsOfUnit(withAbilities([both]))).toContain("hitPenalty");
    const against = ab("Warp-forged", "Each time an attack is made against this unit, subtract 1 from the Wound roll.");
    expect(effectsOfUnit(withAbilities([against]))).toContain("woundPenalty");
  });

  it("wording it doesn't recognise either way is left as before (never silently dropped)", () => {
    const vague = ab("Veil", "Subtract 1 from the Hit roll.");
    expect(effectsOfUnit(withAbilities([vague]))).toContain("hitPenalty");
  });
});
const effectsOfUnit = (u: NormalizedUnit) => detectDefensiveAbilities(u, []).detected.map((d) => d.effect.kind);

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
