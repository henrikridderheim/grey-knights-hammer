#!/usr/bin/env node
/**
 * Data pipeline: fetches BSData/wh40k-11e (11th-edition, community-maintained but
 * independently verified accurate — see scripts/verification-report.md) faction
 * catalogue JSON files from GitHub, normalizes each faction's datasheets into a
 * compact schema this app can consume, and writes one JSON file per faction to
 * public/data/<slug>.json plus a public/data/index.json manifest.
 *
 * Run via `npm run sync-data`. See scripts/PIPELINE_NOTES.md for known shortcuts
 * and judgment calls made while parsing this messy, real-world data source.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public", "data");

const GITHUB_API_LISTING = "https://api.github.com/repos/BSData/wh40k-11e/contents/";
const RAW_BASE = "https://raw.githubusercontent.com/BSData/wh40k-11e/main/";

// The core game-system file (not a faction catalogue — different top-level shape,
// `{gameSystem: {...}}` instead of `{catalogue: {...}}`). Its keyword glossary is
// already hand-verified into src/engine/keywords.ts, so we skip it here entirely.
const SKIP_FILES = new Set(["Warhammer 40,000.json"]);

// Loyalist Space Marine chapter catalogues (Ultramarines, Blood Angels, etc.) do NOT
// inline the ~130 generic Space Marine datasheets — they only contain their own
// chapter-specific characters/relics, and reference the base catalogue via
// `catalogueLinks[].importRootEntries`. For usable per-chapter coverage we merge in
// units from this exact base catalogue when a faction file links to it. We deliberately
// do NOT auto-merge the other common imports (e.g. "Imperium - Agents of the Imperium",
// "Imperium - Imperial Knights - Library") — those pull in allied-detachment options
// far beyond the chapter's own datasheets and would bloat every Imperium faction file
// for little benefit to this tool. See PIPELINE_NOTES.md.
const AUTO_MERGE_BASE_CATALOGUE = "Imperium - Space Marines";

let warningCount = 0;
function warn(...args) {
  warningCount++;
  console.warn("[warn]", ...args);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "grey-knights-hammer-data-pipeline" },
  });
  if (!res.ok) {
    throw new Error(`fetch failed ${res.status} ${res.statusText}: ${url}`);
  }
  return res.json();
}

async function fetchListing() {
  const entries = await fetchJson(GITHUB_API_LISTING);
  return entries.filter((e) => e.name.endsWith(".json") && !SKIP_FILES.has(e.name));
}

// ---------------------------------------------------------------------------
// BattleScribe catalogue parsing primitives
// ---------------------------------------------------------------------------

/** Builds a lookup of every id-bearing shared node in a catalogue, for resolving
 * entryLinks (which reference nodes elsewhere in the file by targetId). */
function buildIdIndex(catalogue) {
  const byId = new Map();
  for (const e of catalogue.sharedSelectionEntries || []) byId.set(e.id, e);
  for (const g of catalogue.sharedSelectionEntryGroups || []) byId.set(g.id, g);
  return byId;
}

function buildRuleIndex(catalogue) {
  const byId = new Map();
  for (const r of catalogue.sharedRules || []) byId.set(r.id, r);
  return byId;
}

/** Some datasheets (notably several Tyranids units) define their "Unit" statline
 * profile as a standalone `catalogue.sharedProfiles` entry, referenced from the
 * model's `infoLinks` (type "profile") rather than inlined or reached via a normal
 * entryLink. This indexes those for collectProfilesDeep to resolve. */
function buildProfileIndex(catalogue) {
  const byId = new Map();
  for (const p of catalogue.sharedProfiles || []) byId.set(p.id, p);
  return byId;
}

function charText(profile, name) {
  const c = (profile.characteristics || []).find((c) => c.name === name);
  if (!c) return undefined;
  const t = (c.$text ?? "").trim();
  return t === "" ? undefined : t;
}

/** Recursively collects every `profiles` entry reachable from a node, resolving
 * `entryLinks` (including inside nested `selectionEntryGroups`) against the
 * catalogue's id index, and `infoLinks` of type "profile" against the shared
 * profile index (see buildProfileIndex). Cycle-safe via a visited-id guard. */
function collectProfilesDeep(node, byId, profileById = new Map(), visited = new Set()) {
  const profiles = [];
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.id) {
      if (visited.has(n.id)) return;
      visited.add(n.id);
    }
    for (const p of n.profiles || []) profiles.push(p);
    for (const child of n.selectionEntries || []) walk(child);
    for (const group of n.selectionEntryGroups || []) walk(group);
    for (const link of n.entryLinks || []) {
      const target = byId.get(link.targetId);
      if (target) walk(target);
    }
    for (const link of n.infoLinks || []) {
      if (link.type !== "profile") continue;
      const profile = profileById.get(link.targetId);
      if (profile) profiles.push(profile);
    }
  }
  walk(node);
  return profiles;
}

// ---------------------------------------------------------------------------
// Field-level parsers (messy-text -> normalized values)
// ---------------------------------------------------------------------------

/** "4+" -> 4. "N/A" / "-" / undefined -> 0 (torrent/auto-hit weapons carry their
 * own `torrent` keyword flag, so a 0 skill is inert but present, matching how
 * src/engine/attackSequence.ts short-circuits torrent weapons before the skill
 * check). */
function parseSkill(text) {
  if (!text) return 0;
  const m = text.match(/(\d+)\s*\+/);
  return m ? Number(m[1]) : 0;
}

/** "-2" -> 2 (engine convention: ap is a positive number = how much it worsens
 * the save). "0"/undefined -> 0. */
function parseAp(text) {
  if (!text) return 0;
  const n = Number(text.replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

const DICE_MEAN = { D3: 2, D6: 3.5 };

/** Parses Attacks/Damage characteristic text into a DiceSpec. Handles plain
 * integers, "D3"/"D6", "D6+N". The engine's DiceSpec has no multi-die-count
 * field, so "2D6"/"3D6" style values (rare — mostly big blast weapons) are
 * approximated as a flat mean (documented in PIPELINE_NOTES.md: this trades
 * variance for a representable value, average damage is preserved). */
function parseDice(text) {
  if (!text) return 1;
  const s = text.trim();
  if (/^\d+$/.test(s)) return Number(s);

  let m = s.match(/^D(3|6)$/i);
  if (m) return { dice: `D${m[1]}` };

  m = s.match(/^D(3|6)\+(\d+)$/i);
  if (m) return { dice: `D${m[1]}`, flat: Number(m[2]) };

  m = s.match(/^(\d+)D(3|6)$/i);
  if (m) {
    const count = Number(m[1]);
    const die = `D${m[2]}`;
    warn(`approximating multi-die spec "${s}" as flat mean (engine DiceSpec has no dice-count field)`);
    return Math.round(count * DICE_MEAN[die]);
  }

  m = s.match(/^(\d+)D(3|6)\+(\d+)$/i);
  if (m) {
    const count = Number(m[1]);
    const die = `D${m[2]}`;
    const flat = Number(m[3]);
    warn(`approximating multi-die spec "${s}" as flat mean (engine DiceSpec has no dice-count field)`);
    return Math.round(count * DICE_MEAN[die] + flat);
  }

  warn(`unrecognized dice spec "${s}", defaulting to 1`);
  return 1;
}

function parseRange(text) {
  if (!text) return undefined;
  if (/melee/i.test(text)) return undefined;
  const n = Number(text.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Parses the free-text "Keywords" weapon characteristic (e.g. "Lethal Hits,
 * Rapid Fire 2, Twin-linked") into our WeaponKeywords shape. Keywords the
 * engine doesn't model (Heavy, Assault, Pistol, Hazardous, Indirect Fire, One
 * Shot, ...) are preserved verbatim in `rawKeywords` for reference but dropped
 * from the structured `keywords` object — the simulator has no field for them. */
function parseWeaponKeywords(text) {
  const keywords = {};
  const raw = [];
  let isPsychic = false;
  if (!text || text.trim() === "-" || text.trim() === "") {
    return { keywords, raw, isPsychic };
  }
  const tokens = text.split(",").map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    raw.push(token);
    let m;
    if (/^torrent$/i.test(token)) {
      keywords.torrent = true;
    } else if ((m = token.match(/^rapid fire (\d+)$/i))) {
      keywords.rapidFire = Number(m[1]);
    } else if ((m = token.match(/^melta (\d+)$/i))) {
      keywords.melta = Number(m[1]);
    } else if (/^blast$/i.test(token)) {
      keywords.blast = true;
    } else if ((m = token.match(/^sustained hits (\d+)$/i))) {
      keywords.sustainedHits = Number(m[1]);
    } else if ((m = token.match(/^sustained hits (D3|D6)$/i))) {
      // Rare "Sustained Hits DX" form — the engine's field is a plain number.
      // Stored as the die-string itself; not strictly WeaponProfile-typed, but
      // this is plain JSON data, not compiled TS. See PIPELINE_NOTES.md.
      keywords.sustainedHits = m[1].toUpperCase();
      warn(`weapon keyword "Sustained Hits ${m[1]}" has non-numeric X, stored as string`);
    } else if (/^lethal hits$/i.test(token)) {
      keywords.lethalHits = true;
    } else if (/^devastating wounds$/i.test(token)) {
      keywords.devastatingWounds = true;
    } else if (/^twin-linked$/i.test(token)) {
      keywords.twinLinked = true;
    } else if ((m = token.match(/^anti-([a-z0-9\- ]+?)\s+(\d)\+$/i))) {
      keywords.antiKeyword = m[1].trim().toUpperCase();
      keywords.antiThreshold = Number(m[2]);
    } else if (/^ignores cover$/i.test(token)) {
      keywords.ignoresCover = true;
    } else if (/^precision$/i.test(token)) {
      keywords.precision = true;
    } else if (/^extra attacks$/i.test(token)) {
      keywords.extraAttacksName = "__SELF__"; // resolved to the weapon's own name by parseWeaponProfile
    } else if (/^psychic$/i.test(token)) {
      isPsychic = true;
    }
    // else: unmodeled keyword (Heavy, Assault, Pistol, Hazardous, Indirect Fire,
    // One Shot, Lance, Hazardous, etc.) — kept in `raw` only.
  }
  return { keywords, raw, isPsychic };
}

function parseWeaponProfile(profile) {
  const isMelee = profile.typeName === "Melee Weapons";
  const rangeText = charText(profile, "Range");
  const attacksText = charText(profile, "A");
  const skillText = charText(profile, isMelee ? "WS" : "BS") ?? charText(profile, "WS") ?? charText(profile, "BS");
  const strengthText = charText(profile, "S");
  const apText = charText(profile, "AP");
  const damageText = charText(profile, "D");
  const keywordsText = charText(profile, "Keywords");

  const { keywords, raw, isPsychic } = parseWeaponKeywords(keywordsText);
  if (keywords.extraAttacksName === "__SELF__") keywords.extraAttacksName = profile.name;

  const strength = Number((strengthText || "0").replace(/[^\d]/g, ""));
  if (!strengthText || !Number.isFinite(strength)) {
    warn(`weapon "${profile.name}" missing/unparseable Strength ("${strengthText}")`);
  }

  return {
    name: profile.name,
    isMelee,
    range: isMelee ? undefined : parseRange(rangeText),
    attacks: parseDice(attacksText),
    skill: parseSkill(skillText),
    strength: Number.isFinite(strength) ? strength : 0,
    ap: parseAp(apText),
    damage: parseDice(damageText),
    keywords,
    rawKeywords: raw,
    ...(isPsychic ? { isPsychic: true } : {}),
  };
}

/** Best-effort squad-size composition string from the unit's own
 * selectionEntryGroups min/max "selections" constraints (the group that offers
 * per-model wargear choices). Does not attempt to reconstruct full composition
 * text like "1 Sergeant + 4-9 Marines" — see PIPELINE_NOTES.md. */
function guessComposition(entry) {
  let best = null;
  for (const group of entry.selectionEntryGroups || []) {
    const hasModelEntries = (group.selectionEntries || []).some(
      (e) => e.type === "model" || e.type === "unit"
    );
    if (!hasModelEntries) continue;
    const min = (group.constraints || []).find((c) => c.type === "min" && c.field === "selections");
    const max = (group.constraints || []).find((c) => c.type === "max" && c.field === "selections");
    if (min || max) {
      best = { min: min?.value, max: max?.value };
      break;
    }
  }
  if (!best) return "1 model";
  if (best.min != null && best.max != null) {
    return best.min === best.max ? `${best.min} models` : `${best.min}-${best.max} models`;
  }
  if (best.min != null) return `${best.min}+ models`;
  if (best.max != null) return `up to ${best.max} models`;
  return "1 model";
}

function parseAbilities(entry, allProfiles, ruleIndex) {
  const abilities = [];
  const seen = new Set();

  for (const profile of allProfiles) {
    if (profile.typeName !== "Abilities") continue;
    const text = charText(profile, "Description") ?? "";
    if (seen.has(profile.name)) continue;
    seen.add(profile.name);
    abilities.push({ name: profile.name, text });
  }

  for (const link of entry.infoLinks || []) {
    if (link.type !== "rule") continue;
    if (seen.has(link.name)) continue;
    const rule = ruleIndex.get(link.targetId);
    if (!rule) continue;
    seen.add(link.name);
    abilities.push({ name: rule.name, text: rule.description || "" });
  }

  return abilities;
}

function parseCanLead(abilities) {
  const leaderAbility = abilities.find((a) => a.name === "Leader");
  if (!leaderAbility) return [];
  return leaderAbility.text
    .split("\n")
    .map((line) => line.replace(/^[\s■\-*]+/, "").trim())
    .filter((line) => line && !/^this model can be attached/i.test(line));
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalizes one top-level unit/model selectionEntry into this app's schema. */
function normalizeUnit(entry, faction, byId, ruleIndex, profileIndex) {
  // The "Unit" statline profile isn't always on the entry itself — for squads with
  // a model-count choice group (e.g. Ork "Boyz", Tau "Strike Team"), it lives one or
  // two levels down inside `selectionEntryGroups[].selectionEntries[].profiles`, and
  // for some Tyranids units it's a standalone shared profile linked via `infoLinks`.
  // We do a single deep collection up front and reuse it for statline/weapons/abilities.
  const allProfiles = collectProfilesDeep(entry, byId, profileIndex);
  const statProfile =
    (entry.profiles || []).find((p) => p.typeName === "Unit") ??
    allProfiles.find((p) => p.typeName === "Unit");
  if (!statProfile) {
    warn(`unit "${entry.name}" (${faction}) has no "Unit" profile, skipping`);
    return null;
  }

  const move = charText(statProfile, "M");
  const toughnessText = charText(statProfile, "T");
  const saveText = charText(statProfile, "Sv");
  const invulnText = charText(statProfile, "InvSv") ?? charText(statProfile, "InSv");
  const woundsText = charText(statProfile, "W");
  const leadership = charText(statProfile, "LD") ?? charText(statProfile, "Ld");
  const ocText = charText(statProfile, "OC");

  const toughness = Number(toughnessText);
  const wounds = Number(woundsText);
  const oc = Number(ocText);
  const save = saveText ? Number(saveText.replace(/[^\d]/g, "")) : undefined;
  const invulnSave = invulnText ? Number(invulnText.replace(/[^\d]/g, "")) : undefined;

  if (!Number.isFinite(toughness) || !Number.isFinite(wounds) || !save) {
    warn(`unit "${entry.name}" (${faction}) has incomplete statline, skipping`);
    return null;
  }

  const weaponProfiles = allProfiles.filter(
    (p) => p.typeName === "Ranged Weapons" || p.typeName === "Melee Weapons"
  );
  const seenWeapons = new Set();
  const weapons = [];
  for (const wp of weaponProfiles) {
    const key = wp.name + "|" + JSON.stringify(wp.characteristics?.map((c) => c.$text));
    if (seenWeapons.has(key)) continue;
    seenWeapons.add(key);
    try {
      weapons.push(parseWeaponProfile(wp));
    } catch (err) {
      warn(`weapon "${wp.name}" on unit "${entry.name}" (${faction}) failed to parse: ${err.message}`);
    }
  }

  const abilities = parseAbilities(entry, allProfiles, ruleIndex);
  const canLead = parseCanLead(abilities);

  const categoryLinks = (entry.categoryLinks || []).map((c) => c.name);
  let factionKeyword = null;
  const keywords = [];
  for (const c of categoryLinks) {
    if (c.startsWith("Faction:")) {
      factionKeyword = c.replace(/^Faction:\s*/, "");
      continue;
    }
    if (c === entry.name) continue; // self-referential category, not a real keyword
    keywords.push(c);
  }

  const ptsCost = (entry.costs || []).find((c) => c.name === "pts");
  const points = ptsCost ? ptsCost.value : null;

  const isCharacter = keywords.some((k) => k.toUpperCase() === "CHARACTER");
  const isLegends = /\[Legends\]/i.test(entry.name);

  return {
    id: slugify(entry.name),
    name: entry.name,
    faction,
    factionKeyword,
    points,
    composition: guessComposition(entry),
    statline: {
      move: move ?? "0\"",
      toughness,
      save,
      ...(invulnSave ? { invulnSave } : {}),
      wounds,
      leadership: leadership ?? "-",
      oc: Number.isFinite(oc) ? oc : 0,
    },
    keywords,
    weapons,
    abilities,
    isCharacter,
    canLead,
    ...(isLegends ? { legends: true } : {}),
  };
}

/** Normalizes every root (top-level roster-selectable) unit in a catalogue.
 *
 * Some factions (Astra Militarum, Craftworlds, Drukhari, Chaos Daemons/Knights,
 * Imperial Knights, ...) are thin wrapper catalogues: their own
 * `sharedSelectionEntries` is empty/near-empty, and their root `entryLinks` point
 * at ids living in a separate linked "Library" catalogue file (regardless of that
 * link's `importRootEntries` flag — that flag only governs BattleScribe's
 * roster auto-population UI, not whether the ids are resolvable). So id/rule/
 * profile indexes are built as the union of this catalogue and every catalogue it
 * links to via `catalogueLinks` (one level, matched by file base name in
 * `rawCatalogues`) — this only enables resolving this catalogue's own entryLinks
 * correctly; it does not add any extra root units beyond what this catalogue
 * itself lists (that would re-introduce the SM-chapter-style bloat we deliberately
 * avoid — see AUTO_MERGE_BASE_CATALOGUE handling in main() for the one case where
 * pulling in another catalogue's full root unit list is actually desired). */
function normalizeCatalogueUnits(catalogue, factionDisplayName, rawCatalogues = new Map()) {
  const byId = buildIdIndex(catalogue);
  const ruleIndex = buildRuleIndex(catalogue);
  const profileIndex = buildProfileIndex(catalogue);

  for (const link of catalogue.catalogueLinks || []) {
    const linked = rawCatalogues.get(link.name);
    if (!linked) continue;
    for (const [id, node] of buildIdIndex(linked)) if (!byId.has(id)) byId.set(id, node);
    for (const [id, rule] of buildRuleIndex(linked)) if (!ruleIndex.has(id)) ruleIndex.set(id, rule);
    for (const [id, p] of buildProfileIndex(linked)) if (!profileIndex.has(id)) profileIndex.set(id, p);
  }

  const rootLinks = (catalogue.entryLinks || []).filter((l) => {
    const target = byId.get(l.targetId);
    return target && (target.type === "unit" || target.type === "model");
  });

  const units = [];
  for (const link of rootLinks) {
    const entry = byId.get(link.targetId);
    try {
      const unit = normalizeUnit(entry, factionDisplayName, byId, ruleIndex, profileIndex);
      if (unit) units.push(unit);
    } catch (err) {
      warn(`unit "${entry?.name}" (${factionDisplayName}) threw during normalization: ${err.message}`);
    }
  }
  return units;
}

function displayNameFromFileBase(fileBase) {
  // Drop only the leading domain prefix ("Imperium - ", "Chaos - ", "Aeldari - ",
  // "Library - "), keeping everything after it — e.g. "Imperium - Imperial Knights -
  // Library" -> "Imperial Knights - Library" (not the ambiguous bare "Library",
  // which would collide in the UI with the "Imperial Knights" faction itself).
  const parts = fileBase.split(" - ");
  return (parts.length > 1 ? parts.slice(1) : parts).join(" - ").trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log("Fetching faction file listing from GitHub...");
  const listing = await fetchListing();
  console.log(`Found ${listing.length} faction files to process.`);

  const rawCatalogues = new Map(); // fileBase -> catalogue

  for (const file of listing) {
    const fileBase = file.name.replace(/\.json$/, "");
    console.log(`Fetching ${file.name}...`);
    try {
      const json = await fetchJson(file.download_url);
      const catalogue = json.catalogue;
      if (!catalogue) {
        warn(`${file.name} has no top-level "catalogue" key, skipping entirely`);
        continue;
      }
      rawCatalogues.set(fileBase, catalogue);
    } catch (err) {
      warn(`failed to fetch/parse ${file.name}: ${err.message}`);
    }
  }

  // NOTE: catalogueLinks[].name references the *file* base name (e.g. "Imperium -
  // Space Marines"), not the linked catalogue's own internal `.name` field (which is
  // actually "Imperium - Adeptus Astartes - Space Marines" — a real inconsistency in
  // the source data). So base-catalogue lookups below are keyed by file base name via
  // `rawCatalogues`, not by catalogue.name.

  const manifest = { factions: {}, lastSynced: new Date().toISOString() };

  for (const [fileBase, catalogue] of rawCatalogues) {
    const displayName = displayNameFromFileBase(fileBase);
    const slug = slugify(fileBase);

    console.log(`Normalizing ${fileBase} (${catalogue.sharedSelectionEntries?.length ?? 0} shared entries)...`);
    let units;
    try {
      units = normalizeCatalogueUnits(catalogue, displayName, rawCatalogues);
    } catch (err) {
      warn(`failed to normalize ${fileBase}: ${err.message}`);
      continue;
    }

    // Merge in the base Space Marines roster for loyalist chapter catalogues.
    const importsBaseSM = (catalogue.catalogueLinks || []).some(
      (l) => l.importRootEntries && l.name === AUTO_MERGE_BASE_CATALOGUE
    );
    if (importsBaseSM && fileBase !== AUTO_MERGE_BASE_CATALOGUE) {
      const baseCatalogue = rawCatalogues.get(AUTO_MERGE_BASE_CATALOGUE);
      if (baseCatalogue) {
        const baseUnits = normalizeCatalogueUnits(baseCatalogue, displayName, rawCatalogues);
        const ownNames = new Set(units.map((u) => u.name));
        for (const bu of baseUnits) {
          if (ownNames.has(bu.name)) continue; // chapter-specific override wins
          units.push(bu);
        }
        console.log(`  merged ${baseUnits.length} base Space Marine datasheets into ${displayName}`);
      } else {
        warn(`${fileBase} imports "${AUTO_MERGE_BASE_CATALOGUE}" but that catalogue wasn't loaded`);
      }
    }

    if (units.length === 0) {
      warn(`${fileBase} produced zero usable units, skipping file write`);
      continue;
    }

    const outPath = path.join(OUT_DIR, `${slug}.json`);
    await writeFile(
      outPath,
      JSON.stringify({ faction: displayName, slug, units }, null, 2)
    );
    manifest.factions[displayName] = { slug, file: `${slug}.json`, unitCount: units.length };
    console.log(`  wrote ${units.length} units -> public/data/${slug}.json`);
  }

  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote manifest -> public/data/index.json (${Object.keys(manifest.factions).length} factions)`);
  console.log(`Done. ${warningCount} warnings emitted during the run.`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exitCode = 1;
});
