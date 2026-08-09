/**
 * Parses plain-text army list exports (BattleScribe, NewRecruit, or the official
 * Warhammer 40,000 app) into structured units matched against this app's
 * normalized datasheet JSON (see scripts/fetch-and-parse-data.mjs).
 *
 * No real sample exports were available while writing this — the three formats
 * below are synthetic, built from general knowledge of how each tool formats its
 * plain-text export. The parser is intentionally line-heuristic-based (not a
 * rigid grammar for one exact format) so it can be adjusted once real samples
 * arrive; see src/parser/parseArmyList.test.ts for the fixtures it's tested
 * against, and scripts/PIPELINE_NOTES.md for the judgment calls made here.
 */

import type {
  DatasheetProvider,
  NormalizedFactionFile,
  NormalizedUnit,
} from "./types";

export interface ParsedWargearLine {
  /** The line as it appeared in the source text (trimmed, bullet-stripped). */
  rawText: string;
  /** Leading/trailing "9x" style multiplier, if present. */
  count: number | null;
  /** Name of the weapon on the matched datasheet, if confidently matched. */
  matchedWeaponName: string | null;
}

export interface ParsedUnit {
  /** Unit name as it appeared in the list (points suffix stripped). */
  rawName: string;
  /** Points value stated in the list next to this unit, if present. */
  points: number | null;
  /** Model count for the unit, if a "Nx <Unit Name>" composition line was found. */
  modelCount: number | null;
  matchedUnitId: string | null;
  matchedUnitName: string | null;
  /** Full matched datasheet, for convenience — null when unresolved. */
  datasheet: NormalizedUnit | null;
  wargear: ParsedWargearLine[];
  isWarlord: boolean;
  enhancement: string | null;
}

export interface ParseArmyListResult {
  faction: string | null;
  detachment: string | null;
  units: ParsedUnit[];
  /** Raw lines that looked like a unit entry but couldn't be confidently matched
   * to any datasheet in the resolved faction (or no faction could be resolved at
   * all). Never silently dropped — always surfaced here for the user to review. */
  unresolved: string[];
  totalPoints: number | null;
}

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

const BULLET_CHARS = "•◦▪●○‣∙*-";
const BULLET_RE = new RegExp(`^[${BULLET_CHARS}]+\\s*`);

/** Section-header words seen across BattleScribe/NewRecruit/WH-app exports.
 * Matched after stripping bullets/plus-decoration and case-folding. Not
 * exhaustive — the ALL-CAPS fallback in `isLikelyHeader` catches most others. */
const KNOWN_HEADERS = new Set([
  "HQ",
  "TROOPS",
  "ELITES",
  "FAST ATTACK",
  "HEAVY SUPPORT",
  "LORD OF WAR",
  "FORTIFICATION",
  "DEDICATED TRANSPORT",
  "DEDICATED TRANSPORTS",
  "CHARACTER",
  "CHARACTERS",
  "BATTLELINE",
  "OTHER DATASHEETS",
  "ALLIED UNITS",
  "NO FORCE ORG SLOT",
  "CONFIGURATION",
]);

function stripBullet(line: string): string {
  return line.replace(BULLET_RE, "").trim();
}

/** Strips leading/trailing "+" decoration used by BattleScribe's classic export
 * ("++ Battle Forged, 2000 Points ++", "+ HQ +"), returning the inner text. */
function stripPlusDecoration(line: string): string {
  return line.replace(/^\+{1,}\s*/, "").replace(/\s*\+{1,}$/, "").trim();
}

function isBlankOrDecorative(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  // Lines made up only of punctuation/decoration, e.g. "===", "----".
  if (/^[+=\-~_ ]+$/.test(t)) return true;
  return false;
}

function isLikelyHeader(cleaned: string): boolean {
  const upper = cleaned.toUpperCase();
  if (KNOWN_HEADERS.has(upper)) return true;
  // Fallback: short, all-caps (ignoring spaces/slashes/ampersands), no digits —
  // catches force-org headers not in the known list above.
  if (
    cleaned.length > 0 &&
    cleaned.length <= 40 &&
    !/\d/.test(cleaned) &&
    /^[A-Z /&'-]+$/.test(upper) &&
    cleaned === upper &&
    cleaned !== cleaned.toLowerCase()
  ) {
    return true;
  }
  return false;
}

/** Strips a trailing "(80 pts)" / "(80 points)" / "[80pts]" suffix, returning
 * the remaining text and the parsed points value (or null). */
function extractTrailingPoints(text: string): { text: string; points: number | null } {
  const m = text.match(/^(.*?)[\s]*[[(]\s*(\d+)\s*(?:pts?|points?)\.?\s*[\])]\s*$/i);
  if (!m) return { text, points: null };
  return { text: m[1].trim(), points: Number(m[2]) };
}

/** Strips a leading "9x " or trailing "x9" model/weapon-count multiplier. */
function extractCount(text: string): { text: string; count: number | null } {
  let m = text.match(/^(\d+)\s*x\s*(.+)$/i);
  if (m) return { text: m[2].trim(), count: Number(m[1]) };
  m = text.match(/^(.+?)\s*x\s*(\d+)$/i);
  if (m) return { text: m[1].trim(), count: Number(m[2]) };
  return { text, count: null };
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Faction / detachment / total-points detection
// ---------------------------------------------------------------------------

/** Result of scanning the header text for an explicit faction declaration —
 * either a "Faction: X" label or a bare line matching a known faction name.
 * `found: false` means neither was present at all, which is the only case
 * where falling back to fuzzy cross-faction scoring (see resolveFaction) is
 * appropriate — an explicit-but-unrecognized declaration should never be
 * silently overridden by a guess. */
type FactionDeclaration = { found: true; name: string; recognized: boolean } | { found: false };

function findExplicitFactionName(lines: string[], knownFactionNames: Set<string>): FactionDeclaration {
  for (const raw of lines) {
    const cleaned = stripPlusDecoration(stripBullet(raw));
    if (cleaned === "") continue;

    const labeled = cleaned.match(/^faction\s*:\s*(.+)$/i);
    if (labeled) {
      const candidate = labeled[1].trim();
      for (const name of knownFactionNames) {
        if (normalizeForMatch(name) === normalizeForMatch(candidate)) {
          return { found: true, name, recognized: true };
        }
      }
      // Explicit "Faction:" label but not a known name — still a strong enough
      // signal to report the raw candidate as-is; caller won't be able to load
      // data for it and everything becomes unresolved, which is the honest
      // outcome here (never silently substitute a guessed faction instead).
      return { found: true, name: candidate, recognized: false };
    }

    for (const name of knownFactionNames) {
      if (normalizeForMatch(name) === normalizeForMatch(cleaned)) {
        return { found: true, name, recognized: true };
      }
    }
  }
  return { found: false };
}

function findDetachment(lines: string[], factionName: string | null): string | null {
  for (const raw of lines) {
    const cleaned = stripPlusDecoration(stripBullet(raw));
    const labeled = cleaned.match(/^detachment\s*:\s*(.+)$/i);
    if (labeled) return labeled[1].trim();
  }
  // Heuristic fallback: a short standalone line in the header zone (before the
  // first unresolved/matched unit) that isn't the faction name, a header, or a
  // points total. Common in NewRecruit/WH-app exports which print the
  // detachment name on its own line without a "Detachment:" label.
  let seenFaction = factionName === null;
  for (const raw of lines) {
    const cleaned = stripPlusDecoration(stripBullet(raw));
    if (cleaned === "") continue;
    if (!seenFaction) {
      if (factionName && normalizeForMatch(cleaned) === normalizeForMatch(factionName)) {
        seenFaction = true;
      }
      continue;
    }
    if (isLikelyHeader(cleaned)) continue;
    if (/\(\s*\d+\s*(?:pts?|points?)\s*\)/i.test(cleaned)) continue; // has its own points, likely a unit
    if (/^\d+\s*(?:pts?|points?)\s*$/i.test(cleaned)) continue; // bare points total
    if (/total/i.test(cleaned)) continue;
    if (isGenericMetadataLine(cleaned)) continue;
    return cleaned;
  }
  return null;
}

function findTotalPoints(lines: string[]): number | null {
  for (const raw of lines) {
    const cleaned = stripPlusDecoration(stripBullet(raw));
    const m = cleaned.match(/total[^\d]*(\d+)\s*(?:pts?|points?)/i);
    if (m) return Number(m[1]);
  }
  // Fallback: a "(2000 points)" style value in the header zone (first 6 lines),
  // typical of NewRecruit/WH-app export headers that state list size up top
  // rather than a "Total:" footer.
  for (const raw of lines.slice(0, 6)) {
    const cleaned = stripPlusDecoration(stripBullet(raw));
    const m = cleaned.match(/[[(]\s*(\d+)\s*(?:pts?|points?)\s*[\])]/i) ?? cleaned.match(/^(\d+)\s*points?$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unit-block parsing (given a resolved faction's datasheet index, or none)
// ---------------------------------------------------------------------------

interface LineInfo {
  raw: string;
  cleaned: string; // bullet-stripped, trimmed
  hasBullet: boolean;
  indent: number; // count of leading whitespace chars
}

function classifyLines(lines: string[]): LineInfo[] {
  return lines.map((raw) => {
    const indentMatch = raw.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const withoutIndent = raw.slice(indent);
    const hasBullet = new RegExp(`^[${BULLET_CHARS}]`).test(withoutIndent);
    return { raw, cleaned: stripBullet(withoutIndent), hasBullet, indent };
  });
}

/** "Key: Value" summary lines BattleScribe/NewRecruit print in the roster header
 * ("Name:", "Battle Size:", "Show Costs:", "Selection Rules:", ...) — never how
 * an actual unit or wargear line is formatted, so safe to skip generically.
 * "Enhancement:" is excluded — that's handled as a wargear-level annotation on
 * the current unit block, not a document-level boundary. */
function isGenericMetadataLine(dedecorated: string): boolean {
  const m = dedecorated.match(/^([A-Za-z][A-Za-z ]{1,25}):\s+\S/);
  if (!m) return false;
  return m[1].trim().toLowerCase() !== "enhancement";
}

function isSectionBoundaryLine(cleaned: string, factionName: string | null): boolean {
  if (cleaned === "") return true;
  if (isBlankOrDecorative(cleaned)) return true;
  // Any "+...+"-wrapped line (BattleScribe's classic export title/total/summary
  // style, e.g. "++ Total: [255 pts] ++") is always a boundary — real selectable
  // units are never wrapped this way.
  if (/^\+{1,}.*\+{1,}$/.test(cleaned)) return true;
  const dedecorated = stripPlusDecoration(cleaned);
  if (isLikelyHeader(dedecorated)) return true;
  if (/^faction\s*:/i.test(dedecorated)) return true;
  if (/^detachment\s*:/i.test(dedecorated)) return true;
  if (/total/i.test(dedecorated) && /\d/.test(dedecorated)) return true;
  if (isGenericMetadataLine(dedecorated)) return true;
  if (factionName && normalizeForMatch(dedecorated) === normalizeForMatch(factionName)) return true;
  return false;
}

function buildUnitNameIndex(faction: NormalizedFactionFile): Map<string, NormalizedUnit> {
  const index = new Map<string, NormalizedUnit>();
  for (const unit of faction.units) {
    index.set(normalizeForMatch(unit.name), unit);
  }
  return index;
}

/** Parses the unit blocks out of the list body. `unitIndex` is null when no
 * faction could be resolved — every top-level block is then unresolved. */
function parseUnitBlocks(
  lines: LineInfo[],
  unitIndex: Map<string, NormalizedUnit> | null,
  factionName: string | null
): { units: ParsedUnit[]; unresolved: string[] } {
  const units: ParsedUnit[] = [];
  const unresolved: string[] = [];
  let current: ParsedUnit | null = null;
  // Indentation of the currently-open unit's own name line. A later line is a
  // *sibling* unit (not a sub-line of the current one) only if it has no
  // bullet AND its indent is back at or above this — i.e. indentation is
  // judged relative to the enclosing unit, not against a fixed column. This
  // matters because some export styles (e.g. NewRecruit) indent annotation
  // lines like "Warlord" by a couple of spaces without a bullet, which a fixed
  // "indent <= 2" threshold would misread as a new top-level unit.
  let currentUnitIndent: number | null = null;
  // Once a faction is resolved, a top-level line that doesn't match any of its
  // units *before* we've matched anything at all is far more likely to be
  // leftover roster-title/preamble text (e.g. "Necrons Battle Force (255
  // points)", a bare detachment-name line NewRecruit-style exports print
  // without a "Detachment:" label, ...) than a genuine unrecognized unit —
  // real unit entries in every export style we've seen start appearing only
  // after that preamble. So such lines are silently absorbed rather than
  // flagged unresolved, but *only* while unitIndex is non-null (a real
  // faction was resolved): if no faction could be resolved at all, we have no
  // basis for distinguishing preamble from content, so nothing is suppressed
  // and every unmatched line is surfaced immediately — see the "faction
  // resolution" describe block in parseArmyList.test.ts.
  let sawFirstMatchedUnit = false;

  for (const line of lines) {
    if (isSectionBoundaryLine(line.cleaned, factionName)) {
      continue;
    }

    const isTopLevel =
      !line.hasBullet && (currentUnitIndent === null || line.indent <= currentUnitIndent);

    if (isTopLevel) {
      const { text: withoutPoints, points } = extractTrailingPoints(line.cleaned);
      const matched = unitIndex?.get(normalizeForMatch(withoutPoints)) ?? null;

      if (!matched && !sawFirstMatchedUnit && unitIndex !== null) {
        continue; // preamble noise, absorbed silently — see comment above
      }
      if (matched) sawFirstMatchedUnit = true;

      current = {
        rawName: withoutPoints,
        points,
        modelCount: null,
        matchedUnitId: matched?.id ?? null,
        matchedUnitName: matched?.name ?? null,
        datasheet: matched,
        wargear: [],
        isWarlord: false,
        enhancement: null,
      };
      units.push(current);
      currentUnitIndent = line.indent;
      if (!matched) unresolved.push(line.raw.trim());
      continue;
    }

    // Non-top-level line: wargear/annotation attached to the current unit block.
    if (!current) {
      // A sub-line with no preceding unit block — shouldn't normally happen, but
      // don't silently drop it either.
      unresolved.push(line.raw.trim());
      continue;
    }

    if (/^warlord$/i.test(line.cleaned)) {
      current.isWarlord = true;
      continue;
    }
    const enhancement = line.cleaned.match(/^enhancement\s*:\s*(.+)$/i);
    if (enhancement) {
      current.enhancement = enhancement[1].trim();
      continue;
    }

    const { text: withoutPoints } = extractTrailingPoints(line.cleaned);
    const { text: withoutCount, count } = extractCount(withoutPoints);

    const matchedWeapon = current.datasheet
      ? current.datasheet.weapons.find(
          (w) => normalizeForMatch(w.name) === normalizeForMatch(withoutCount)
        ) ?? null
      : null;

    // First sub-line that carries a count but isn't a recognized weapon is taken
    // to be the "Nx <Unit Name>" model-composition line BattleScribe/NewRecruit
    // print under the unit header (e.g. "10x Necron Warrior") — not a weapon.
    if (!matchedWeapon && count !== null && current.modelCount === null && current.wargear.length === 0) {
      current.modelCount = count;
      continue;
    }

    current.wargear.push({
      rawText: withoutCount,
      count,
      matchedWeaponName: matchedWeapon?.name ?? null,
    });
  }

  return { units, unresolved };
}

// ---------------------------------------------------------------------------
// Faction resolution (including the fuzzy-across-all-factions fallback)
// ---------------------------------------------------------------------------

async function resolveFaction(
  lines: string[],
  provider: DatasheetProvider
): Promise<{ factionName: string | null; factionData: NormalizedFactionFile | null }> {
  const manifest = await provider.getManifest();
  const knownFactionNames = new Set(Object.keys(manifest.factions));

  const explicit = findExplicitFactionName(lines, knownFactionNames);
  if (explicit.found) {
    // An explicit declaration was present — honor it as-is even if it's not a
    // recognized faction name. Falling back to fuzzy-scoring unit names here
    // would risk silently overriding a real (if unrecognized/misspelled)
    // declaration with a guess, which the parser must never do.
    if (explicit.recognized) {
      const slug = manifest.factions[explicit.name].slug;
      return { factionName: explicit.name, factionData: await provider.loadFaction(slug) };
    }
    return { factionName: explicit.name, factionData: null };
  }

  // Fallback: no explicit faction declaration found at all. Try every faction's
  // unit index against every structurally-top-level line in the document, and
  // pick whichever faction matches the most lines — but only if there's a clear
  // winner, so we don't misattribute an ambiguous list to the wrong faction.
  const classified = classifyLines(lines);
  const candidateNames = classified
    .filter((l) => !l.hasBullet && l.indent <= 2 && !isSectionBoundaryLine(l.cleaned, null))
    .map((l) => normalizeForMatch(extractTrailingPoints(l.cleaned).text));

  if (candidateNames.length === 0) {
    return { factionName: null, factionData: null };
  }

  let best: { name: string; slug: string; score: number } | null = null;
  let secondBestScore = 0;

  for (const [name, entry] of Object.entries(manifest.factions)) {
    const data = await provider.loadFaction(entry.slug);
    const unitNames = new Set(data.units.map((u) => normalizeForMatch(u.name)));
    const score = candidateNames.filter((c) => unitNames.has(c)).length;
    if (score === 0) continue;
    if (!best || score > best.score) {
      secondBestScore = best?.score ?? 0;
      best = { name, slug: entry.slug, score };
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  if (best && best.score > secondBestScore) {
    return { factionName: best.name, factionData: await provider.loadFaction(best.slug) };
  }

  return { factionName: null, factionData: null };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function parseArmyList(
  text: string,
  provider: DatasheetProvider
): Promise<ParseArmyListResult> {
  const lines = text.split(/\r\n|\r|\n/);

  const { factionName, factionData } = await resolveFaction(lines, provider);
  const detachment = findDetachment(lines, factionName);
  const totalPoints = findTotalPoints(lines);

  const unitIndex = factionData ? buildUnitNameIndex(factionData) : null;
  const classified = classifyLines(lines);
  const { units, unresolved } = parseUnitBlocks(classified, unitIndex, factionName);

  return { faction: factionName, detachment, units, unresolved, totalPoints };
}
