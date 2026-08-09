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
  DataManifest,
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

/** "Attached as: Leader (Character)" / "Attached as: Bodyguard (Battleline)" /
 * "Attached as: Support (Character)" — the Warhammer 40,000 app's label for
 * this unit's role within an attached (Leader+Bodyguard) grouping. */
export type AttachedRole = "leader" | "bodyguard" | "support";

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
  /** Role within its "Attached unit N" grouping, if any — see `attachedRole`
   * on this type and `ParseArmyListResult.attachedGroups`. */
  attachedRole: AttachedRole | null;
  /** Which "Attached unit N" block this belongs to (1-based, matching the
   * export's own numbering), or null for a standalone unit. */
  attachedGroupIndex: number | null;
}

/** One "Attached unit N" grouping — a Bodyguard unit plus the Leader(s) (and
 * occasionally a Support character) attached to it. In 11e these are treated
 * as a single unit for almost all rules purposes (targeting, wound
 * allocation, ...), so damage math should combine them into one target
 * rather than evaluating the Leader and Bodyguard separately. */
export interface AttachedGroup {
  index: number;
  members: ParsedUnit[];
}

export interface ParseArmyListResult {
  faction: string | null;
  detachment: string | null;
  units: ParsedUnit[];
  /** Leader+Bodyguard groupings extracted from `units` — see `AttachedGroup`. */
  attachedGroups: AttachedGroup[];
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

/** "Attached unit 1", "Attached Unit", "ATTACHED UNIT 2" — a sub-header the
 * Warhammer 40,000 app prints before each Leader+Bodyguard pairing inside its
 * "ATTACHED UNITS" section. Mixed-case and carries a digit, so it doesn't hit
 * the ALL-CAPS/no-digit fallback below — needs its own check. */
function isAttachedUnitSubHeader(cleaned: string): boolean {
  return /^attached\s+unit\s*\d*$/i.test(cleaned);
}

function isLikelyHeader(cleaned: string): boolean {
  const upper = cleaned.toUpperCase();
  if (KNOWN_HEADERS.has(upper)) return true;
  if (isAttachedUnitSubHeader(cleaned)) return true;
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

/** Strips commas from a plain-text-formatted number ("1,995" -> "1995") before
 * parsing — large lists (points totals especially) are often comma-grouped. */
function parseLooseInt(digits: string): number {
  return Number(digits.replace(/,/g, ""));
}

/** Strips a trailing "(80 pts)" / "(80 points)" / "[80pts]" / "(1,995 points)"
 * suffix, returning the remaining text and the parsed points value (or null). */
function extractTrailingPoints(text: string): { text: string; points: number | null } {
  const m = text.match(/^(.*?)[\s]*[[(]\s*([\d,]+)\s*(?:pts?|points?)\.?\s*[\])]\s*$/i);
  if (!m) return { text, points: null };
  return { text: m[1].trim(), points: parseLooseInt(m[2]) };
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

/** Strips a datasheet weapon's multi-profile decoration — a leading "➤ " marker
 * and/or a trailing " - <mode>" suffix (e.g. "➤ Manreaper - strike", "Shearing
 * claws - sweep") — to the base weapon name a plain-text list export states
 * when it doesn't select a specific fire mode. */
function stripWeaponModeDecoration(name: string): string {
  return name
    .replace(/^[➤>]\s*/, "")
    .replace(/\s*-\s*[a-z0-9 ]+$/i, "")
    .trim();
}

/** Tolerant match between a wargear line's stated name and a datasheet weapon
 * name: exact (normalized) match first, then falls back to comparing base
 * names with multi-profile mode decoration stripped from the datasheet side,
 * and finally tolerates a singular/plural mismatch (list exports often
 * pluralize a weapon name when its count is >1, e.g. "2x Heavy bolters" vs the
 * datasheet's singular "Heavy bolter") on either side. */
function weaponNameMatches(candidateText: string, weaponName: string): boolean {
  const candidate = normalizeForMatch(candidateText);
  const full = normalizeForMatch(weaponName);
  if (candidate === full) return true;
  const base = normalizeForMatch(stripWeaponModeDecoration(weaponName));
  if (candidate === base) return true;
  const singularize = (s: string) => (s.endsWith("s") ? s.slice(0, -1) : s);
  return singularize(candidate) === singularize(base) || singularize(candidate) === singularize(full);
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
    if (/\(\s*[\d,]+\s*(?:pts?|points?)\s*\)/i.test(cleaned)) continue; // has its own points, likely a unit
    if (/^[\d,]+\s*(?:pts?|points?)\s*$/i.test(cleaned)) continue; // bare points total
    if (/total/i.test(cleaned)) continue;
    if (isGenericMetadataLine(cleaned)) continue;
    return cleaned;
  }
  return null;
}

function findTotalPoints(lines: string[]): number | null {
  for (const raw of lines) {
    const cleaned = stripPlusDecoration(stripBullet(raw));
    const m = cleaned.match(/total[^\d]*([\d,]+)\s*(?:pts?|points?)/i);
    if (m) return parseLooseInt(m[1]);
  }
  // Fallback: a "(2000 points)" style value in the header zone (first 6 lines),
  // typical of NewRecruit/WH-app export headers that state list size up top
  // rather than a "Total:" footer.
  for (const raw of lines.slice(0, 6)) {
    const cleaned = stripPlusDecoration(stripBullet(raw));
    const m = cleaned.match(/[[(]\s*([\d,]+)\s*(?:pts?|points?)\s*[\])]/i) ?? cleaned.match(/^([\d,]+)\s*points?$/i);
    if (m) return parseLooseInt(m[1]);
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
 * "Enhancement(s):" is excluded — that's handled as a wargear-level annotation
 * on the current unit block, not a document-level boundary (the WH app export
 * uses the plural "Enhancements:", other tools the singular). */
function isGenericMetadataLine(dedecorated: string): boolean {
  const m = dedecorated.match(/^([A-Za-z][A-Za-z ]{1,25}):\s+\S/);
  if (!m) return false;
  return !/^enhancements?$/.test(m[1].trim().toLowerCase());
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
 * faction could be resolved — every top-level block is then unresolved.
 *
 * `resolveUnit` is awaited once per top-level line, before that unit's own
 * sub-lines are processed — its result becomes `current.datasheet` for the
 * whole block, which weapon-matching (and therefore model-count summing)
 * depends on. It must fully settle (primary faction, then any cross-faction
 * ally fallback) before wargear parsing starts for that unit, not after —
 * otherwise sub-lines get matched against no datasheet at all and every
 * counted line gets misread as a composition line. `hasFactionIndex`
 * controls the "silently absorb pre-first-match preamble" behavior below,
 * same as when a plain synchronous index was used directly. */
async function parseUnitBlocks(
  lines: LineInfo[],
  resolveUnit: (rawName: string) => Promise<NormalizedUnit | null>,
  factionName: string | null,
  hasFactionIndex: boolean
): Promise<{ units: ParsedUnit[]; orphanSubLines: string[] }> {
  const units: ParsedUnit[] = [];
  // Only the rare "sub-line with no preceding unit block" case — top-level
  // lines that don't match the primary faction are tracked via `units`
  // (matchedUnitId: null) instead, so the caller can retry them against other
  // factions (allied units, e.g. an Inquisitor in a Custodes list) before
  // deciding they're genuinely unresolved.
  const orphanSubLines: string[] = [];
  let current: ParsedUnit | null = null;
  // Indentation of the currently-open unit's own name line. A later line is a
  // *sibling* unit (not a sub-line of the current one) only if it has no
  // bullet AND its indent is back at or above this — i.e. indentation is
  // judged relative to the enclosing unit, not against a fixed column. This
  // matters because some export styles (e.g. NewRecruit) indent annotation
  // lines like "Warlord" by a couple of spaces without a bullet, which a fixed
  // "indent <= 2" threshold would misread as a new top-level unit.
  let currentUnitIndent: number | null = null;
  // Indent of the shallowest sub-line seen so far for the current unit — the
  // "model-group" level. Some exports state composition as a single flat line
  // ("10x Necron Warrior"); others (e.g. mixed-loadout squads like Plague
  // Marines, or a Champion + Terminators split like Deathshroud) list several
  // sibling group lines at this same indent ("1x Plague Champion", then "4x
  // Plague Marines"), each with its own further-indented wargear beneath it.
  // Every unmatched, counted line *at this indent* contributes to the unit's
  // total model count (summed, not just the first one found) — lines deeper
  // than this are always wargear/annotations for whichever group they're
  // nested under, never composition.
  let currentGroupIndent: number | null = null;
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
  // Which "Attached unit N" grouping subsequent units belong to, per the
  // Warhammer 40,000 app's own numbering — reset to null once a real section
  // header (CHARACTER, OTHER DATASHEETS, ...) ends the attached-units block.
  let currentAttachedGroupIndex: number | null = null;

  for (const line of lines) {
    if (isAttachedUnitSubHeader(line.cleaned)) {
      const m = line.cleaned.match(/(\d+)/);
      currentAttachedGroupIndex = m ? Number(m[1]) : (currentAttachedGroupIndex ?? 0) + 1;
      continue;
    }
    // "Attached as: Leader (Character)" etc. is a sub-line of the unit that was
    // just opened — capture its role before the generic-metadata boundary
    // check below would otherwise silently swallow it.
    const attachedAs = line.cleaned.match(/^attached\s+as\s*:\s*(leader|bodyguard|support)\b/i);
    if (attachedAs && current) {
      current.attachedRole = attachedAs[1].toLowerCase() as AttachedRole;
      continue;
    }
    if (isSectionBoundaryLine(line.cleaned, factionName)) {
      // A real force-org header (CHARACTER, BATTLELINE, OTHER DATASHEETS, ...)
      // closes out the attached-units block; "Attached unit N" itself is
      // handled above and never reaches here.
      if (isLikelyHeader(stripPlusDecoration(line.cleaned)) && !isAttachedUnitSubHeader(line.cleaned)) {
        currentAttachedGroupIndex = null;
      }
      continue;
    }

    const isTopLevel =
      !line.hasBullet && (currentUnitIndent === null || line.indent <= currentUnitIndent);

    if (isTopLevel) {
      const { text: withoutPoints, points } = extractTrailingPoints(line.cleaned);
      const matched = await resolveUnit(withoutPoints);

      if (!matched && !sawFirstMatchedUnit && hasFactionIndex) {
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
        attachedRole: null,
        attachedGroupIndex: currentAttachedGroupIndex,
      };
      units.push(current);
      currentUnitIndent = line.indent;
      currentGroupIndent = null;
      continue;
    }

    // Non-top-level line: wargear/annotation attached to the current unit block.
    if (!current) {
      // A sub-line with no preceding unit block — shouldn't normally happen, but
      // don't silently drop it either.
      orphanSubLines.push(line.raw.trim());
      continue;
    }

    if (/^warlord$/i.test(line.cleaned)) {
      current.isWarlord = true;
      continue;
    }
    const enhancement = line.cleaned.match(/^enhancements?\s*:\s*(.+)$/i);
    if (enhancement) {
      current.enhancement = enhancement[1].trim();
      continue;
    }

    const { text: withoutPoints } = extractTrailingPoints(line.cleaned);
    const { text: withoutCount, count } = extractCount(withoutPoints);

    const matchedWeapon = current.datasheet
      ? current.datasheet.weapons.find((w) => weaponNameMatches(withoutCount, w.name)) ?? null
      : null;

    if (currentGroupIndent === null) currentGroupIndent = line.indent;

    // An unmatched, counted line at the shallow "model-group" indent is a
    // composition line — either the whole unit ("10x Necron Warrior") or one
    // of several sibling role-groups that make up the unit together ("1x
    // Plague Champion" + "4x Plague Marines" = 5 models total) — so its count
    // is *added* to the running total rather than only recorded once.
    if (!matchedWeapon && count !== null && line.indent === currentGroupIndent) {
      current.modelCount = (current.modelCount ?? 0) + count;
      continue;
    }

    current.wargear.push({
      rawText: withoutCount,
      count,
      matchedWeaponName: matchedWeapon?.name ?? null,
    });
  }

  return { units, orphanSubLines };
}

// ---------------------------------------------------------------------------
// Cross-faction ally resolution — a unit that doesn't match the list's
// primary faction (e.g. an Inquisitor allied into an Adeptus Custodes list)
// might still be a real datasheet from a *different* faction. Tried only
// after the primary faction's index has already failed to match, and only
// accepted when the name is unique across every other faction — an ambiguous
// name (matches in 2+ factions) is left unresolved rather than guessed.
// ---------------------------------------------------------------------------

async function resolveAlliedUnit(
  rawName: string,
  provider: DatasheetProvider,
  manifest: DataManifest,
  primaryFactionName: string | null
): Promise<NormalizedUnit | null> {
  const target = normalizeForMatch(rawName);
  const otherFactions = Object.entries(manifest.factions).filter(([name]) => name !== primaryFactionName);
  const results = await Promise.all(
    otherFactions.map(async ([, entry]) => {
      const data = await provider.loadFaction(entry.slug);
      return data.units.find((u) => normalizeForMatch(u.name) === target) ?? null;
    })
  );
  const matches = results.filter((u): u is NormalizedUnit => u !== null);
  return matches.length === 1 ? matches[0] : null;
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
  // Cache the manifest lazily — only fetched at all if some unit actually needs
  // the cross-faction ally fallback below (the common case, a fully-matched
  // list, never touches it).
  let manifestPromise: Promise<DataManifest> | null = null;
  const resolveUnit = async (rawName: string): Promise<NormalizedUnit | null> => {
    const primary = unitIndex?.get(normalizeForMatch(rawName)) ?? null;
    if (primary) return primary;
    // Only meaningful once a real primary faction was resolved — if the
    // faction itself is unrecognized/unresolved we have no reliable basis for
    // guessing, so every unit stays unresolved (never silently cross-matched).
    if (!factionData) return null;
    if (!manifestPromise) manifestPromise = provider.getManifest();
    return resolveAlliedUnit(rawName, provider, await manifestPromise, factionName);
  };

  const classified = classifyLines(lines);
  const { units, orphanSubLines } = await parseUnitBlocks(classified, resolveUnit, factionName, unitIndex !== null);

  const unresolved = [
    ...orphanSubLines,
    ...units
      .filter((u) => u.matchedUnitId === null)
      .map((u) => (u.points ? `${u.rawName} (${u.points} points)` : u.rawName)),
  ];

  const groupIndexes = [...new Set(units.map((u) => u.attachedGroupIndex).filter((i): i is number => i !== null))];
  const attachedGroups: AttachedGroup[] = groupIndexes
    .sort((a, b) => a - b)
    .map((index) => ({ index, members: units.filter((u) => u.attachedGroupIndex === index) }));

  return { faction: factionName, detachment, units, attachedGroups, unresolved, totalPoints };
}
