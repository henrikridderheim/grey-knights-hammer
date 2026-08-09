import { describe, expect, it } from "vitest";
import { parseArmyList } from "./parseArmyList";
import type {
  DataManifest,
  DatasheetProvider,
  NormalizedFactionFile,
} from "./types";

// ---------------------------------------------------------------------------
// In-memory fixture data + provider (no network access, per project instructions)
// ---------------------------------------------------------------------------

const NECRONS: NormalizedFactionFile = {
  faction: "Necrons",
  slug: "necrons",
  units: [
    {
      id: "technomancer",
      name: "Technomancer",
      faction: "Necrons",
      factionKeyword: "Necrons",
      points: 75,
      composition: "1 model",
      statline: { move: "5\"", toughness: 4, save: 4, invulnSave: 4, wounds: 4, leadership: "7+", oc: 1 },
      keywords: ["Infantry", "Character"],
      weapons: [
        {
          name: "Staff of Light",
          isMelee: false,
          range: 18,
          attacks: 1,
          skill: 4,
          strength: 5,
          ap: 1,
          damage: 1,
          keywords: {},
          rawKeywords: [],
        },
        {
          name: "Voltaic Staff",
          isMelee: true,
          attacks: 3,
          skill: 4,
          strength: 5,
          ap: 1,
          damage: 1,
          keywords: {},
          rawKeywords: [],
        },
      ],
      abilities: [],
      isCharacter: true,
      canLead: ["Necron Warriors"],
    },
    {
      id: "necron-warriors",
      name: "Necron Warriors",
      faction: "Necrons",
      factionKeyword: "Necrons",
      points: 80,
      composition: "10-20 models",
      statline: { move: "5\"", toughness: 4, save: 4, wounds: 1, leadership: "7+", oc: 2 },
      keywords: ["Infantry", "Battleline"],
      weapons: [
        {
          name: "Gauss flayer",
          isMelee: false,
          range: 24,
          attacks: 1,
          skill: 4,
          strength: 4,
          ap: 0,
          damage: 1,
          keywords: { lethalHits: true, rapidFire: 1 },
          rawKeywords: ["Lethal Hits", "Rapid Fire 1"],
        },
        {
          name: "Gauss reaper",
          isMelee: false,
          range: 12,
          attacks: 2,
          skill: 4,
          strength: 4,
          ap: 1,
          damage: 1,
          keywords: { lethalHits: true },
          rawKeywords: ["Lethal Hits"],
        },
        {
          name: "Close combat weapon",
          isMelee: true,
          attacks: 1,
          skill: 4,
          strength: 4,
          ap: 0,
          damage: 1,
          keywords: {},
          rawKeywords: [],
        },
      ],
      abilities: [],
      isCharacter: false,
      canLead: [],
    },
    {
      id: "canoptek-wraiths",
      name: "Canoptek Wraiths",
      faction: "Necrons",
      factionKeyword: "Necrons",
      points: 100,
      composition: "3-6 models",
      statline: { move: "10\"", toughness: 6, save: 3, wounds: 4, leadership: "7+", oc: 2 },
      keywords: ["Vehicle"],
      weapons: [
        {
          name: "Wraith claws",
          isMelee: true,
          attacks: 4,
          skill: 3,
          strength: 7,
          ap: 2,
          damage: 2,
          keywords: {},
          rawKeywords: [],
        },
      ],
      abilities: [],
      isCharacter: false,
      canLead: [],
    },
  ],
};

const SPACE_MARINES: NormalizedFactionFile = {
  faction: "Space Marines",
  slug: "imperium-space-marines",
  units: [
    {
      id: "intercessor-squad",
      name: "Intercessor Squad",
      faction: "Space Marines",
      factionKeyword: "Adeptus Astartes",
      points: 80,
      composition: "5-10 models",
      statline: { move: "6\"", toughness: 4, save: 3, wounds: 2, leadership: "6+", oc: 2 },
      keywords: ["Infantry", "Battleline"],
      weapons: [
        {
          name: "Bolt rifle",
          isMelee: false,
          range: 24,
          attacks: 2,
          skill: 3,
          strength: 4,
          ap: 1,
          damage: 1,
          keywords: {},
          rawKeywords: [],
        },
        {
          name: "Close combat weapon",
          isMelee: true,
          attacks: 1,
          skill: 3,
          strength: 4,
          ap: 0,
          damage: 1,
          keywords: {},
          rawKeywords: [],
        },
      ],
      abilities: [],
      isCharacter: false,
      canLead: [],
    },
    {
      id: "captain",
      name: "Captain",
      faction: "Space Marines",
      factionKeyword: "Adeptus Astartes",
      points: 70,
      composition: "1 model",
      statline: { move: "6\"", toughness: 4, save: 3, invulnSave: 4, wounds: 5, leadership: "6+", oc: 1 },
      keywords: ["Infantry", "Character"],
      weapons: [
        {
          name: "Master-crafted power weapon",
          isMelee: true,
          attacks: 5,
          skill: 2,
          strength: 5,
          ap: 2,
          damage: 2,
          keywords: {},
          rawKeywords: [],
        },
      ],
      abilities: [],
      isCharacter: true,
      canLead: ["Intercessor Squad"],
    },
  ],
};

function makeFixtureProvider(factions: NormalizedFactionFile[]): DatasheetProvider {
  const manifest: DataManifest = { factions: {}, lastSynced: "2026-08-08T00:00:00.000Z" };
  for (const f of factions) {
    manifest.factions[f.faction] = { slug: f.slug, file: `${f.slug}.json`, unitCount: f.units.length };
  }
  return {
    async getManifest() {
      return manifest;
    },
    async loadFaction(slug: string) {
      const found = factions.find((f) => f.slug === slug);
      if (!found) throw new Error(`no fixture faction for slug "${slug}"`);
      return found;
    },
  };
}

const provider = makeFixtureProvider([NECRONS, SPACE_MARINES]);

// ---------------------------------------------------------------------------
// Synthetic sample army lists, one per export tool style.
// These are hand-built approximations (no real sample exports were available
// at the time this was written) — see the module doc comment in
// parseArmyList.ts. Structure is deliberately kept adjustable via the
// line-heuristic approach rather than a per-format grammar.
// ---------------------------------------------------------------------------

/** BattleScribe "Full" plain-text export style: "++"-wrapped title/total lines,
 * "+ Section +" force-org headers, nested "•" bullets two levels deep. */
const BATTLESCRIBE_SAMPLE = `
++ Battle Forged, 2000 Points ++

+ Battle Size: Strike Force +
+ Show Costs: All +

Faction: Necrons
Detachment: Awakened Dynasty

+ HQ +

Technomancer (75 pts)
    • Warlord
    • Enhancement: Nightmare Shroud
    1x Technomancer
        • 1x Staff of Light
        • 1x Voltaic Staff

+ Battleline +

Necron Warriors (80 pts)
    10x Necron Warrior
        • 9x Gauss flayer
        • 1x Gauss reaper
        • 10x Close combat weapon

+ Elites +

Canoptek Wraiths (100 pts)
    3x Canoptek Wraith
        • 3x Wraith claws

++ Total: [255 pts] ++
`;

/** NewRecruit plain-text export style: title line up top with points in
 * parens, ALL-CAPS force-org headers, single-level "•" bullets, no explicit
 * "Faction:"/"Detachment:" labels — faction/detachment are bare lines. */
const NEWRECRUIT_SAMPLE = `
Necrons Battle Force (255 points)

Necrons
Awakened Dynasty

CHARACTERS

Technomancer (75 points)
  Warlord
  Enhancement: Nightmare Shroud
  • Staff of Light
  • Voltaic Staff

BATTLELINE

Necron Warriors (80 points)
  10x Necron Warrior
  • 9x Gauss flayer
  • 1x Gauss reaper
  • 10x Close combat weapon

ELITES

Canoptek Wraiths (100 points)
  3x Canoptek Wraith
  • 3x Wraith claws

Total: 255 points
`;

/** Official Warhammer 40,000 app export style: faction/detachment/points-limit
 * on their own lines up top, no bullets at all for wargear (just extra
 * indentation), weapon counts as a trailing "xN". Also includes one
 * intentionally bogus unit name to exercise the `unresolved` path. */
const WH_APP_SAMPLE = `
Necrons
Awakened Dynasty
Strike Force (2000 Points)

CHARACTER
Technomancer (75 Points)
   Staff of Light x1
   Voltaic Staff x1
   Warlord

BATTLELINE
Necron Warriors (80 Points)
   Gauss flayer x9
   Gauss reaper x1
   Close combat weapon x10

Homebrew Necron Overlord on a Motorbike (150 Points)

Total: 305 Points
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseArmyList — BattleScribe-style export", () => {
  it("extracts faction, detachment, and total points", async () => {
    const result = await parseArmyList(BATTLESCRIBE_SAMPLE, provider);
    expect(result.faction).toBe("Necrons");
    expect(result.detachment).toBe("Awakened Dynasty");
    expect(result.totalPoints).toBe(255);
  });

  it("matches all three units to the Necrons datasheet index", async () => {
    const result = await parseArmyList(BATTLESCRIBE_SAMPLE, provider);
    expect(result.units.map((u) => u.matchedUnitName)).toEqual([
      "Technomancer",
      "Necron Warriors",
      "Canoptek Wraiths",
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("captures Warlord and Enhancement annotations without polluting wargear", async () => {
    const result = await parseArmyList(BATTLESCRIBE_SAMPLE, provider);
    const tech = result.units[0];
    expect(tech.isWarlord).toBe(true);
    expect(tech.enhancement).toBe("Nightmare Shroud");
    expect(tech.wargear.some((w) => /warlord|enhancement/i.test(w.rawText))).toBe(false);
  });

  it("resolves weapon names and per-model composition counts", async () => {
    const result = await parseArmyList(BATTLESCRIBE_SAMPLE, provider);
    const warriors = result.units[1];
    expect(warriors.modelCount).toBe(10);
    expect(warriors.wargear).toEqual([
      { rawText: "Gauss flayer", count: 9, matchedWeaponName: "Gauss flayer" },
      { rawText: "Gauss reaper", count: 1, matchedWeaponName: "Gauss reaper" },
      { rawText: "Close combat weapon", count: 10, matchedWeaponName: "Close combat weapon" },
    ]);
  });

  it("reads each unit's stated points value", async () => {
    const result = await parseArmyList(BATTLESCRIBE_SAMPLE, provider);
    expect(result.units.map((u) => u.points)).toEqual([75, 80, 100]);
  });
});

describe("parseArmyList — NewRecruit-style export", () => {
  it("detects faction and detachment from bare header lines (no labels)", async () => {
    const result = await parseArmyList(NEWRECRUIT_SAMPLE, provider);
    expect(result.faction).toBe("Necrons");
    expect(result.detachment).toBe("Awakened Dynasty");
  });

  it("matches units despite ALL-CAPS section headers and 'points' spelled out", async () => {
    const result = await parseArmyList(NEWRECRUIT_SAMPLE, provider);
    expect(result.units.map((u) => u.matchedUnitName)).toEqual([
      "Technomancer",
      "Necron Warriors",
      "Canoptek Wraiths",
    ]);
    expect(result.totalPoints).toBe(255);
  });
});

describe("parseArmyList — Warhammer 40,000 app-style export", () => {
  it("matches known units using trailing 'xN' weapon-count style", async () => {
    const result = await parseArmyList(WH_APP_SAMPLE, provider);
    const tech = result.units.find((u) => u.matchedUnitName === "Technomancer");
    expect(tech).toBeDefined();
    expect(tech!.wargear).toEqual(
      expect.arrayContaining([
        { rawText: "Staff of Light", count: 1, matchedWeaponName: "Staff of Light" },
        { rawText: "Voltaic Staff", count: 1, matchedWeaponName: "Voltaic Staff" },
      ])
    );
    expect(tech!.isWarlord).toBe(true);
  });

  it("flags a homebrew/unmatched unit as unresolved instead of guessing", async () => {
    const result = await parseArmyList(WH_APP_SAMPLE, provider);
    const bogus = result.units.find((u) => u.rawName.includes("Homebrew"));
    expect(bogus).toBeDefined();
    expect(bogus!.matchedUnitId).toBeNull();
    expect(bogus!.datasheet).toBeNull();
    expect(result.unresolved.some((line) => line.includes("Homebrew Necron Overlord"))).toBe(true);
  });

  it("does not fuzzy-substitute the unresolved unit for a similarly-themed real one", async () => {
    const result = await parseArmyList(WH_APP_SAMPLE, provider);
    const bogus = result.units.find((u) => u.rawName.includes("Homebrew"));
    // "Homebrew Necron Overlord on a Motorbike" is deliberately not a real
    // datasheet name (real Necrons has an "Overlord", not this) — the parser
    // must never silently match it to something close.
    expect(bogus!.matchedUnitName).toBeNull();
  });
});

describe("parseArmyList — faction resolution", () => {
  it("falls back to scoring all factions' unit indexes when no faction header is present", async () => {
    const headerless = `
Intercessor Squad (80 pts)
  • Bolt rifle
  • Close combat weapon

Captain (70 pts)
  • Master-crafted power weapon

Total: 150 pts
`;
    const result = await parseArmyList(headerless, provider);
    expect(result.faction).toBe("Space Marines");
    expect(result.units.map((u) => u.matchedUnitName)).toEqual(["Intercessor Squad", "Captain"]);
  });

  it("never cross-matches a unit name from a different, unresolved faction", async () => {
    // Necron Warriors is not a Space Marines unit — with no faction resolved,
    // it must be flagged unresolved rather than matched against the wrong index.
    const wrongFaction = `
Faction: Definitely Not A Real Faction
Necron Warriors (80 pts)
  • Gauss flayer
`;
    const result = await parseArmyList(wrongFaction, provider);
    expect(result.faction).toBe("Definitely Not A Real Faction");
    expect(result.units[0].matchedUnitId).toBeNull();
    expect(result.unresolved.length).toBeGreaterThan(0);
  });
});
