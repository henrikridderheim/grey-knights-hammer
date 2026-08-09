import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArmyList } from "./parseArmyList";
import type {
  DataManifest,
  DatasheetProvider,
  NormalizedFactionFile,
} from "./types";
import type { ParsedUnit } from "./parseArmyList";

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

// ---------------------------------------------------------------------------
// Regression: a real user-pasted Death Guard list, against the real (not
// fixture) BSData-derived datasheet JSON. This caught two real bugs: (1) a
// unit whose composition is split across several sibling role-group lines
// (e.g. "1x Plague Champion" + "4x Plague Marines") only counted the first
// group, undercounting the unit; (2) a wargear line whose stated name didn't
// exactly match the datasheet (pluralized, e.g. "Heavy bolters" vs "Heavy
// bolter", or missing a multi-profile mode suffix, e.g. "Manreaper" vs
// "➤ Manreaper - strike") was misread as a second composition line, inflating
// or corrupting the model count entirely.
// ---------------------------------------------------------------------------

describe("parseArmyList — real Death Guard list regression", () => {
  const deathGuardData: NormalizedFactionFile = JSON.parse(
    readFileSync(new URL("../../public/data/chaos-death-guard.json", import.meta.url), "utf-8")
  );
  const dgProvider = makeFixtureProvider([deathGuardData]);

  const DEATH_GUARD_LIST = `
Death Guard
Strike Force (2000 Point)
Shamblerot Vectorium, Flyblown Host (3 Detachment Points)
Force Dispositions: Disruption, Reconnaissance


CHARACTER

Icon Bearer (45 points)
  • 1x Boltgun
  • 1x Plague knife

Lord of Contagion (120 points)
  • Warlord
  • 1x Manreaper


BATTLELINE

Plague Marines (90 points)
  • 1x Plague Champion
    • 1x Plasma Gun
    • 1x Power Fist
  • 4x Plague Marines
    • 4x Plague Knives
    • 2x Heavy Plague Weapon
    • 1x Bubotic Weapons
    • 1x Plague Spewer

Poxwalkers (65 points)
  • 10x Poxwalkers
    • 10x Improvised Weapon

Poxwalkers (65 points)
  • 10x Poxwalkers
    • 10x Improvised Weapon


OTHER DATASHEETS

Chaos Predator Destructor (145 points)
  • 2x Heavy bolters
  • 1x Armoured tracks
  • 1x Combi-bolter
  • 1x Havoc launcher
  • 1x Predator autocannon

Deathshroud Terminators (160 points)
  • 1x Deathshroud Champion
    • 1x Plaguespurt Gauntlet
    • 1x Manreaper
    • 1x Additional Plaguespurt Gauntlet
    • 1x Icon of Despair
  • 2x Deathshroud Terminators
    • 2x Plaguespurt Gauntlet
    • 2x Manreaper

Defiler (300 points)
  • 1x Electroscourge
  • 2x Excruciator cannon
  • 1x Hades battle cannon
  • 1x Heavy baleflamer
  • 1x Shearing claws
`;

  it("resolves the Death Guard faction and matches every unit", async () => {
    const result = await parseArmyList(DEATH_GUARD_LIST, dgProvider);
    expect(result.faction).toBe("Death Guard");
    expect(result.unresolved).toEqual([]);
    expect(result.units.map((u) => u.matchedUnitName)).toEqual([
      "Icon Bearer",
      "Lord of Contagion",
      "Plague Marines",
      "Poxwalkers",
      "Poxwalkers",
      "Chaos Predator Destructor",
      "Deathshroud Terminators",
      "Defiler",
    ]);
  });

  it("leaves single-model units with no explicit composition line uncounted by the parser (app defaults from datasheet composition)", async () => {
    const result = await parseArmyList(DEATH_GUARD_LIST, dgProvider);
    const byName = (name: string) => result.units.find((u) => u.rawName === name)!;
    // Icon Bearer/Lord of Contagion/Defiler state no "1x <name>" line at all in
    // this export style — the parser correctly has no basis to claim a count;
    // it's the app layer's job to fall back to the datasheet's "1 model" composition.
    expect(byName("Icon Bearer").modelCount).toBeNull();
    expect(byName("Lord of Contagion").modelCount).toBeNull();
    expect(byName("Defiler").modelCount).toBeNull();
  });

  it("sums multiple sibling role-group lines into the unit's total model count", async () => {
    const result = await parseArmyList(DEATH_GUARD_LIST, dgProvider);
    const plagueMarines = result.units.find((u) => u.rawName === "Plague Marines")!;
    // 1x Plague Champion + 4x Plague Marines = 5, not 1.
    expect(plagueMarines.modelCount).toBe(5);
    const deathshroud = result.units.find((u) => u.rawName === "Deathshroud Terminators")!;
    // 1x Deathshroud Champion + 2x Deathshroud Terminators = 3, not 1.
    expect(deathshroud.modelCount).toBe(3);
  });

  it("counts a flat single-group unit correctly (sanity check the fix didn't break the simple case)", async () => {
    const result = await parseArmyList(DEATH_GUARD_LIST, dgProvider);
    const poxwalkers = result.units.filter((u) => u.rawName === "Poxwalkers");
    expect(poxwalkers).toHaveLength(2);
    expect(poxwalkers.every((u) => u.modelCount === 10)).toBe(true);
  });

  it("does not mistake a pluralized or multi-profile wargear line for a second composition line", async () => {
    const result = await parseArmyList(DEATH_GUARD_LIST, dgProvider);
    const predator = result.units.find((u) => u.rawName === "Chaos Predator Destructor")!;
    // "2x Heavy bolters" is wargear (2 heavy bolters mounted on 1 vehicle), not "2 Predators".
    expect(predator.modelCount).toBeNull();
    expect(predator.wargear.some((w) => w.matchedWeaponName === "Heavy bolter")).toBe(true);

    const deathshroud = result.units.find((u) => u.rawName === "Deathshroud Terminators")!;
    // "1x Manreaper" / "2x Manreaper" should resolve against the datasheet's
    // multi-profile "➤ Manreaper - strike"/"➤ Manreaper - sweep" entries.
    const manreaperLines = deathshroud.wargear.filter((w) => w.rawText === "Manreaper");
    expect(manreaperLines.length).toBe(2);
    expect(manreaperLines.every((w) => w.matchedWeaponName !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: a real user-pasted Adeptus Custodes list using the Warhammer
// 40,000 app's "ATTACHED UNITS" / "Attached unit N" / "Attached as: ..."
// formatting for Leader+Bodyguard pairings, against the real datasheet JSON.
// Caught: "Attached unit N" sub-headers weren't recognized (became spurious
// unresolved entries once a real unit had already matched), "Enhancements:"
// (plural, as this exporter spells it) wasn't recognized at all, and
// comma-grouped point totals ("1,995 Points") failed to parse.
// ---------------------------------------------------------------------------

describe("parseArmyList — real Adeptus Custodes list regression (attached units)", () => {
  const custodesData: NormalizedFactionFile = JSON.parse(
    readFileSync(new URL("../../public/data/imperium-adeptus-custodes.json", import.meta.url), "utf-8")
  );
  // Inquisitor Draxus is a genuine cross-faction ally (Agents of the Imperium),
  // not a Custodes datasheet — included so the allied-unit fallback has
  // somewhere to actually find it, same as the real app's provider would.
  const agentsData: NormalizedFactionFile = JSON.parse(
    readFileSync(new URL("../../public/data/imperium-agents-of-the-imperium.json", import.meta.url), "utf-8")
  );
  const custodesProvider = makeFixtureProvider([custodesData, agentsData]);

  const CUSTODES_LIST = `T&H (1,995 Points)

Adeptus Custodes
Might of the Moritoi and Shield Host (3 Detachment Points)
Take and Hold
Strike Force (2,000 Points)

ATTACHED UNITS

Attached unit 1

Valerian (110 Points)
  • Attached as: Leader (Character)
  • Warlord
  • 1x Gnosis

Custodian Wardens (250 Points)
  • Attached as: Bodyguard ()
  • 5x Custodian Warden
     ◦ 5x Guardian spear

Attached unit 2

Inquisitor Draxus (110 Points)
  • Attached as: Leader (Character)
  • 1x Dirgesinger
  • 1x Power fist
  • 1x Psychic Tempest

Custodian Guard (170 Points)
  • Attached as: Bodyguard (Battleline)
  • 4x Custodian Guard
     ◦ 1x Misericordia
     ◦ 4x Praesidium Shield
     ◦ 3x Sentinel blade
     ◦ 1x Vexilla

Attached unit 3

Shield-Captain on Dawneagle Jetbike (160 Points)
  • Attached as: Leader (Character)
  • 1x Interceptor lance
  • 1x Salvo launcher
  • Enhancements: From the Hall of Armouries

Vertus Praetors (215 Points)
  • Attached as: Bodyguard ()
  • 3x Vertus Praetor
     ◦ 3x Interceptor lance
     ◦ 3x Salvo launcher

OTHER DATASHEETS

Contemptor-Galatus Dreadnought (190 Points)
  • 1x Galatus warblade
  • Enhancements: Interred Expertise (Upgrade)

Contemptor-Galatus Dreadnought (190 Points)
  • 1x Galatus warblade
  • Enhancements: Interred Expertise (Upgrade)

Prosecutors (45 Points)
  • 1x Prosecutor Sister Superior
     ◦ 1x Boltgun
     ◦ 1x Close combat weapon
  • 3x Prosecutor
     ◦ 3x Boltgun
     ◦ 3x Close combat weapon

Venatari Custodians (165 Points)
  • 3x Venatari Custodian
     ◦ 3x Venatari lance

Venatari Custodians (165 Points)
  • 3x Venatari Custodian
     ◦ 3x Venatari lance

Venatari Custodians (175 Points)
  • 3x Venatari Custodian
     ◦ 3x Venatari lance

Witchseekers (50 Points)
  • 1x Witchseeker Sister Superior
     ◦ 1x Close combat weapon
     ◦ 1x Witchseeker flamer
  • 3x Witchseeker
     ◦ 3x Close combat weapon
     ◦ 3x Witchseeker flamer

Exported with App Version: v2.3.1 (1), Data Version: v913
`;

  it("resolves faction/detachment, the comma-grouped total, and matches every unit with nothing unresolved", async () => {
    const result = await parseArmyList(CUSTODES_LIST, custodesProvider);
    expect(result.faction).toBe("Adeptus Custodes");
    expect(result.detachment).toBe("Might of the Moritoi and Shield Host (3 Detachment Points)");
    expect(result.unresolved).toEqual([]);
    expect(result.units.map((u) => u.matchedUnitName)).toEqual([
      "Valerian",
      "Custodian Wardens",
      "Inquisitor Draxus",
      "Custodian Guard",
      "Shield-Captain on Dawneagle Jetbike",
      "Vertus Praetors",
      "Contemptor-Galatus Dreadnought",
      "Contemptor-Galatus Dreadnought",
      "Prosecutors",
      "Venatari Custodians",
      "Venatari Custodians",
      "Venatari Custodians",
      "Witchseekers",
    ]);
  });

  it("does not turn 'Attached unit N' sub-headers into spurious unresolved units", async () => {
    const result = await parseArmyList(CUSTODES_LIST, custodesProvider);
    expect(result.units.some((u) => /^attached unit/i.test(u.rawName))).toBe(false);
  });

  it("gets every model count right, including single-model Leaders and multi-group Bodyguard squads", async () => {
    const result = await parseArmyList(CUSTODES_LIST, custodesProvider);
    const byName = (name: string) => result.units.find((u) => u.rawName === name)!;
    expect(byName("Valerian").modelCount).toBeNull(); // no explicit line — app defaults from "1 model" composition
    expect(byName("Custodian Wardens").modelCount).toBe(5);
    expect(byName("Inquisitor Draxus").modelCount).toBeNull();
    expect(byName("Custodian Guard").modelCount).toBe(4);
    expect(byName("Shield-Captain on Dawneagle Jetbike").modelCount).toBeNull();
    expect(byName("Vertus Praetors").modelCount).toBe(3);
    expect(result.units.filter((u) => u.rawName === "Prosecutors")[0].modelCount).toBe(4); // 1 Superior + 3 Prosecutor
    expect(result.units.filter((u) => u.rawName === "Witchseekers")[0].modelCount).toBe(4); // 1 Superior + 3 Witchseeker
    for (const u of result.units.filter((x) => x.rawName === "Venatari Custodians")) {
      expect(u.modelCount).toBe(3);
    }
  });

  it("captures the plural 'Enhancements:' label this exporter uses", async () => {
    const result = await parseArmyList(CUSTODES_LIST, custodesProvider);
    const shieldCaptain = byNameOf(result, "Shield-Captain on Dawneagle Jetbike");
    expect(shieldCaptain.enhancement).toBe("From the Hall of Armouries");
    const dreadnoughts = result.units.filter((u) => u.rawName === "Contemptor-Galatus Dreadnought");
    expect(dreadnoughts.every((d) => d.enhancement === "Interred Expertise (Upgrade)")).toBe(true);
  });

  it("groups Leader+Bodyguard pairs into 3 attached groups with the right roles, and leaves standalone units out of any group", async () => {
    const result = await parseArmyList(CUSTODES_LIST, custodesProvider);
    expect(result.attachedGroups).toHaveLength(3);
    expect(result.attachedGroups.map((g) => g.index)).toEqual([1, 2, 3]);

    const [g1, g2, g3] = result.attachedGroups;
    expect(g1.members.map((m) => [m.rawName, m.attachedRole])).toEqual([
      ["Valerian", "leader"],
      ["Custodian Wardens", "bodyguard"],
    ]);
    expect(g2.members.map((m) => [m.rawName, m.attachedRole])).toEqual([
      ["Inquisitor Draxus", "leader"],
      ["Custodian Guard", "bodyguard"],
    ]);
    expect(g3.members.map((m) => [m.rawName, m.attachedRole])).toEqual([
      ["Shield-Captain on Dawneagle Jetbike", "leader"],
      ["Vertus Praetors", "bodyguard"],
    ]);

    const standalone = result.units.filter((u) => u.attachedGroupIndex === null);
    expect(standalone.map((u) => u.rawName)).toEqual([
      "Contemptor-Galatus Dreadnought",
      "Contemptor-Galatus Dreadnought",
      "Prosecutors",
      "Venatari Custodians",
      "Venatari Custodians",
      "Venatari Custodians",
      "Witchseekers",
    ]);
  });
});

function byNameOf(result: { units: ParsedUnit[] }, name: string): ParsedUnit {
  const found = result.units.find((u) => u.rawName === name);
  if (!found) throw new Error(`unit "${name}" not found in parse result`);
  return found;
}
