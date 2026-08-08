/**
 * Types for the normalized datasheet JSON produced by
 * scripts/fetch-and-parse-data.mjs (written to public/data/<slug>.json + index.json),
 * and for the army-list parser's own output.
 *
 * These intentionally mirror src/engine/types.ts's WeaponProfile/DiceSpec/
 * WeaponKeywords shapes where sensible, but are declared independently here
 * rather than importing them: the pipeline's weapon objects carry a couple of
 * extra fields (`rawKeywords`, and an occasional non-numeric `sustainedHits`
 * string like "D3" — see scripts/PIPELINE_NOTES.md) that don't fit the engine's
 * stricter WeaponKeywords type, and this module must never be a reason to touch
 * (or be blocked by) src/engine/*.
 */

export type DiceSpec = number | { dice: "D3" | "D6"; flat?: number };

export interface NormalizedWeaponKeywords {
  torrent?: boolean;
  rapidFire?: number;
  melta?: number;
  blast?: boolean;
  /** Usually a number; rarely a die-string like "D3" (e.g. "Sustained Hits D3") —
   * see scripts/PIPELINE_NOTES.md. */
  sustainedHits?: number | string;
  lethalHits?: boolean;
  devastatingWounds?: boolean;
  twinLinked?: boolean;
  antiKeyword?: string;
  antiThreshold?: number;
  ignoresCover?: boolean;
  precision?: boolean;
  extraAttacksName?: string;
}

export interface NormalizedWeapon {
  name: string;
  isMelee: boolean;
  range?: number;
  attacks: DiceSpec;
  skill: number;
  strength: number;
  ap: number;
  damage: DiceSpec;
  keywords: NormalizedWeaponKeywords;
  /** Every keyword token seen on this weapon's "Keywords" characteristic, verbatim,
   * including ones `keywords` above doesn't model (Heavy, Assault, Pistol, ...). */
  rawKeywords: string[];
  isPsychic?: boolean;
}

export interface NormalizedAbility {
  name: string;
  text: string;
}

export interface NormalizedStatline {
  move: string;
  toughness: number;
  save: number;
  invulnSave?: number;
  wounds: number;
  leadership: string;
  oc: number;
}

export interface NormalizedUnit {
  id: string;
  name: string;
  faction: string;
  factionKeyword: string | null;
  /** Base datasheet cost only — see scripts/PIPELINE_NOTES.md for what's excluded. */
  points: number | null;
  composition: string;
  statline: NormalizedStatline;
  keywords: string[];
  /** Every weapon option reachable anywhere in this unit's wargear tree (all
   * loadout choices pooled together, not just a single "default" loadout) — see
   * scripts/PIPELINE_NOTES.md. */
  weapons: NormalizedWeapon[];
  abilities: NormalizedAbility[];
  isCharacter: boolean;
  canLead: string[];
  legends?: boolean;
}

export interface NormalizedFactionFile {
  faction: string;
  slug: string;
  units: NormalizedUnit[];
}

export interface FactionManifestEntry {
  slug: string;
  file: string;
  unitCount: number;
}

export interface DataManifest {
  factions: Record<string, FactionManifestEntry>;
  lastSynced: string;
}

/** Supplies faction/datasheet data to the parser. Implemented via `fetch` against
 * public/data/*.json for the real app (see fetchDatasheetProvider.ts) and via an
 * in-memory fixture for tests, so parseArmyList.ts never needs network access. */
export interface DatasheetProvider {
  getManifest(): Promise<DataManifest>;
  loadFaction(slug: string): Promise<NormalizedFactionFile>;
}
