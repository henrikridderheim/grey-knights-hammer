/**
 * Reverse ("what threatens ME") analysis: instead of my units killing the
 * opponent's, this simulates each of the OPPONENT's units firing/fighting into
 * each of MY roster units, then surfaces (a) the top 3 biggest threats and
 * (b) whether the opposing list is better into my Dreadknights or my infantry.
 *
 * Data source: the pasted opponent list gives each unit's actual wargear
 * (ParsedUnit.wargear, with per-weapon counts) plus its full datasheet
 * (NormalizedUnit.weapons, with stats), so opponent firepower is reconstructed
 * from what's really in the list — not guessed.
 *
 * Scope/limitations (surfaced in the UI): this uses raw weapon profiles only.
 * It does not model the opponent's stratagems, detachment rules, or buffs
 * (we don't have their army's rules the way we have the Grey Knights'), and
 * melee is only as complete as the wargear the list enumerates. Treat the
 * numbers as a conservative floor.
 */

import type {
  AttackContext,
  DefenseModelGroup,
  TargetUnit,
  WeaponKeywords,
  WeaponProfile,
} from "../engine/types";
import { runUnitPhaseSimulation } from "../engine/simulate";
import { ROSTER, type UnitDefinition } from "./roster";
import type { NormalizedWeapon } from "../parser/types";
import type { ParseArmyListResult, ParsedUnit, ParsedWargearLine } from "../parser/parseArmyList";

/** Lower iteration count — this runs many (opponent unit × my unit × phase)
 * simulations and only needs stable means, not tail percentiles. */
const THREAT_ITERATIONS = 250;

/** How much higher one bucket's fraction-destroyed must be than the other
 * before we call the list "better into" it rather than "balanced". */
const LEANING_BAND = 1.2;

/** Convert a parsed-datasheet weapon into the engine's WeaponProfile. The two
 * shapes are near-identical by design; the only real gap is `sustainedHits`,
 * which the pipeline can leave as a die-string ("D3"/"D6") — coerce those to a
 * flat average so the engine (which wants a number) can use them. */
export function normalizedWeaponToProfile(w: NormalizedWeapon): WeaponProfile {
  const k = w.keywords;
  const sustainedHits =
    typeof k.sustainedHits === "number"
      ? k.sustainedHits
      : typeof k.sustainedHits === "string"
        ? k.sustainedHits.includes("D3")
          ? 2
          : k.sustainedHits.includes("D6")
            ? 3
            : undefined
        : undefined;
  const keywords: WeaponKeywords = {
    torrent: k.torrent,
    rapidFire: k.rapidFire,
    melta: k.melta,
    blast: k.blast,
    sustainedHits,
    lethalHits: k.lethalHits,
    devastatingWounds: k.devastatingWounds,
    twinLinked: k.twinLinked,
    antiKeyword: k.antiKeyword,
    antiThreshold: k.antiThreshold,
    ignoresCover: k.ignoresCover,
    precision: k.precision,
    extraAttacksName: k.extraAttacksName,
  };
  return {
    name: w.name,
    isMelee: w.isMelee,
    range: w.range,
    attacks: w.attacks,
    skill: w.skill,
    strength: w.strength,
    ap: w.ap,
    damage: w.damage,
    keywords,
    isPsychic: w.isPsychic,
  };
}

/** My roster unit as a defensive target: one model group at the unit's
 * statline, sized by the total models across its loadouts. */
export function rosterUnitToTarget(unit: UnitDefinition): TargetUnit {
  const count = unit.loadouts.reduce((sum, l) => sum + l.count, 0);
  const s = unit.statline;
  const group: DefenseModelGroup = {
    label: unit.name,
    count,
    toughness: s.toughness,
    save: s.save,
    invulnSave: s.invulnSave,
    wounds: s.wounds,
  };
  return {
    name: unit.name,
    groups: [group],
    isAttached: false,
    hasCover: false,
    modelCountForBlast: count,
    keywords: unit.keywords.map((kw) => kw.toUpperCase()),
  };
}

/** "Dreadknight-class" = a big, tough, multi-wound model (MONSTER/VEHICLE, or
 * simply very high Toughness). Everything else is infantry for this verdict. */
export function isDreadClass(unit: UnitDefinition): boolean {
  return (
    unit.keywords.includes("MONSTER") ||
    unit.keywords.includes("VEHICLE") ||
    unit.statline.toughness >= 8
  );
}


export type Archetype = "dreadknight" | "elite" | "light";

const ARCHETYPE_LABEL: Record<Archetype, string> = {
  dreadknight: "Dreadknights",
  elite: "elite infantry",
  light: "light infantry",
};

interface ArchetypeRep {
  key: Archetype;
  /** The roster unit standing in for this archetype (shown for transparency). */
  repName: string;
  /** A deliberately over-sized pool of that unit's models, so a unit's damage
   * into it reads as size-independent EFFECTIVE output: per-model overkill is
   * still wasted (the anti-tank vs anti-infantry signal), but the target never
   * fully dies, so the figure isn't capped by (or biased toward) squad size. */
  poolTarget: TargetUnit;
  /** Wounds of one realistic unit of this type — the yardstick a unit's
   * effective output is shown as a fraction of. */
  referenceWounds: number;
  /** Models in one realistic unit (1 for a Dreadknight monster). */
  referenceModels: number;
}

/** Enough target wounds that normal single-unit output never fully clears the
 * pool (so effective damage isn't capped by the unit dying). */
const POOL_WOUNDS = 80;

function repFrom(key: Archetype, unit: UnitDefinition): ArchetypeRep {
  const base = rosterUnitToTarget(unit);
  const referenceModels = base.groups.reduce((s, g) => s + g.count, 0);
  const modelWounds = unit.statline.wounds;
  const referenceWounds = referenceModels * modelWounds;
  const poolModels = Math.max(referenceModels, Math.ceil(POOL_WOUNDS / modelWounds));
  const poolTarget: TargetUnit = {
    ...base,
    groups: base.groups.map((g) => ({ ...g, count: poolModels })),
    // Keep [BLAST] scaled to a realistic unit, not the inflated pool.
    modelCountForBlast: referenceModels,
  };
  return { key, repName: unit.name, poolTarget, referenceWounds, referenceModels };
}

/** One representative target per relevant unit type in MY army: a
 * Dreadknight-class model, an elite-infantry squad (multi-wound, e.g.
 * Terminators), and a light-infantry squad (single/low-wound line troops).
 * Each opponent unit is scored into these three independently, so we can see
 * what each of his units is individually best at killing. */
export function buildArchetypeReps(): ArchetypeRep[] {
  const roster = ROSTER as UnitDefinition[];
  const reps: ArchetypeRep[] = [];

  const dread = roster.find((u) => isDreadClass(u));
  if (dread) reps.push(repFrom("dreadknight", dread));

  const elite = roster.find((u) => !isDreadClass(u) && u.statline.wounds >= 3);
  if (elite) reps.push(repFrom("elite", elite));

  // Light infantry: a low-wound infantry squad, preferring a full 10-model one.
  const lightCandidates = roster.filter(
    (u) => !isDreadClass(u) && u.statline.wounds < 3 && u.keywords.includes("INFANTRY")
  );
  const light = [...lightCandidates].sort(
    (a, b) =>
      b.loadouts.reduce((s, l) => s + l.count, 0) - a.loadouts.reduce((s, l) => s + l.count, 0)
  )[0];
  if (light) reps.push(repFrom("light", light));

  return reps;
}

/** One opposing "combatant": a standalone unit, or an attached
 * Leader+Bodyguard group treated as a single attacker (their wargear pooled). */
interface Combatant {
  name: string;
  points: number | null;
  members: ParsedUnit[];
  /** How many identical copies of this combatant are in the list. */
  multiplicity: number;
}

/** Identity of one member unit — its datasheet plus its exact wargear
 * selection — so genuine duplicates collapse but a differently-kitted unit of
 * the same datasheet stays distinct. */
function memberSignature(u: ParsedUnit): string {
  const wargear = u.wargear
    .filter((w) => w.matchedWeaponName)
    .map((w) => `${w.matchedWeaponName}:${w.count ?? 1}`)
    .sort()
    .join(",");
  return `${u.matchedUnitId ?? u.rawName}|${wargear}`;
}

function buildCombatants(list: ParseArmyListResult): Combatant[] {
  // Raw combatants: each attached group is one attacker (its members deduped —
  // the list parser can lump repeated attached units under one group index,
  // which would otherwise show as "A + B + A + B" and double the firepower),
  // each standalone unit is one attacker.
  const raw: ParsedUnit[][] = [];
  for (const group of list.attachedGroups) {
    const seen = new Set<string>();
    const members: ParsedUnit[] = [];
    for (const m of group.members) {
      const sig = memberSignature(m);
      if (seen.has(sig)) continue;
      seen.add(sig);
      members.push(m);
    }
    if (members.length > 0) raw.push(members);
  }
  for (const unit of list.units) {
    if (unit.attachedGroupIndex == null) raw.push([unit]);
  }

  // Collapse identical combatants (same members + wargear) into one, counting
  // copies — a per-unit-type threat view wants each distinct unit evaluated
  // once, not once per physical copy.
  const byKey = new Map<string, Combatant>();
  for (const members of raw) {
    const key = members.map(memberSignature).sort().join(" + ");
    const existing = byKey.get(key);
    if (existing) {
      existing.multiplicity += 1;
      continue;
    }
    const points = members.some((m) => m.points != null)
      ? members.reduce((sum, m) => sum + (m.points ?? 0), 0)
      : null;
    byKey.set(key, {
      name: members.map((m) => m.rawName).join(" + "),
      points,
      members,
      multiplicity: 1,
    });
  }
  return [...byKey.values()];
}

function weaponForWargearLine(unit: ParsedUnit, line: ParsedWargearLine): { weapon: WeaponProfile; count: number } | null {
  if (!line.matchedWeaponName || !unit.datasheet) return null;
  const nw = unit.datasheet.weapons.find((w) => w.name === line.matchedWeaponName);
  if (!nw) return null;
  return { weapon: normalizedWeaponToProfile(nw), count: line.count ?? 1 };
}

/** Every attack context a combatant brings against one target, split by phase.
 * numAttackingModels = the wargear line's count (e.g. "5x plasma gun" → 5). */
function combatantEngagements(
  combatant: Combatant,
  target: TargetUnit
): { shooting: { ctx: AttackContext }[]; melee: { ctx: AttackContext }[] } {
  const shooting: { ctx: AttackContext }[] = [];
  const melee: { ctx: AttackContext }[] = [];
  for (const member of combatant.members) {
    for (const line of member.wargear) {
      const wp = weaponForWargearLine(member, line);
      if (!wp) continue;
      const ctx: AttackContext = {
        numAttackingModels: wp.count,
        weapon: wp.weapon,
        target,
        halfRange: false,
        hitMod: 0,
        woundMod: 0,
        strengthBonus: 0,
      };
      (wp.weapon.isMelee ? melee : shooting).push({ ctx });
    }
  }
  return { shooting, melee };
}

interface PhaseResult {
  mode: "shooting" | "melee";
  meanDamage: number;
  modelsKilled: number;
  killProbability: number;
}

/** This combatant's threat into one target, via whichever phase does more
 * expected damage (a unit rarely both shoots and fights the same target to
 * full effect in one turn, so the better phase is the fair single figure). */
function bestPhaseInto(combatant: Combatant, target: TargetUnit): PhaseResult | null {
  const { shooting, melee } = combatantEngagements(combatant, target);
  const results: PhaseResult[] = [];
  const run = (engagements: { ctx: AttackContext }[], mode: "shooting" | "melee") => {
    if (engagements.length === 0) return;
    const s = runUnitPhaseSimulation(engagements, { label: `${combatant.name} → ${target.name}`, iterations: THREAT_ITERATIONS });
    results.push({ mode, meanDamage: s.meanDamage, modelsKilled: s.meanModelsKilled, killProbability: s.killProbability });
  };
  run(shooting, "shooting");
  run(melee, "melee");
  if (results.length === 0) return null;
  return results.reduce((best, r) => (r.meanDamage > best.meanDamage ? r : best));
}

/** One opponent unit's result into a single archetype target. */
export interface ArchetypeMatchup {
  key: Archetype;
  label: string;
  repName: string;
  mode: "shooting" | "melee";
  /** Size-independent EFFECTIVE damage per turn into this durability (damage
   * into the over-sized pool, so per-model overkill is still wasted but squad
   * size doesn't bias it). This is the "average damage into a X" figure. */
  meanDamage: number;
  modelsKilled: number;
  /** meanDamage as a fraction (0..1, capped) of one realistic unit of this
   * type — "how close to removing a whole unit of mine." */
  fractionDestroyed: number;
}

/** One opponent unit's full matchup profile across the archetypes, plus what
 * it's naturally best at. */
export interface UnitThreatProfile {
  attackerName: string;
  attackerPoints: number | null;
  /** How many identical copies of this unit are in the list. */
  multiplicity: number;
  matchups: ArchetypeMatchup[];
  /** Archetype it puts the most EFFECTIVE damage into — what it's best at
   * killing (null if it can't meaningfully hurt anything). */
  specialty: Archetype | null;
  /** Matchup closest to removing a whole unit of mine — ranks the top-3. */
  bestMatchup: ArchetypeMatchup;
}

export interface ThreatVerdict {
  leaning: Archetype | "balanced";
  /** Points-weighted share (0..1) of the list specialising into each archetype. */
  weights: Record<Archetype, number>;
  /** How many of his units specialise into each archetype. */
  counts: Record<Archetype, number>;
}

export interface ThreatAnalysisResult {
  archetypes: { key: Archetype; label: string; repName: string; wounds: number; models: number }[];
  /** Every evaluable opponent unit's matchup profile, sorted scariest-first. */
  profiles: UnitThreatProfile[];
  /** First three of `profiles` — the biggest individual threats. */
  topThreats: UnitThreatProfile[];
  verdict: ThreatVerdict;
  /** Opposing combatants that had no usable (matched) weapons to evaluate. */
  skipped: string[];
}

export function computeThreatAnalysis(list: ParseArmyListResult): ThreatAnalysisResult {
  const reps = buildArchetypeReps();
  const combatants = buildCombatants(list);
  const skipped: string[] = [];
  const profiles: UnitThreatProfile[] = [];

  for (const combatant of combatants) {
    const matchups: ArchetypeMatchup[] = [];
    for (const rep of reps) {
      const phase = bestPhaseInto(combatant, rep.poolTarget);
      if (!phase) continue;
      matchups.push({
        key: rep.key,
        label: ARCHETYPE_LABEL[rep.key],
        repName: rep.repName,
        mode: phase.mode,
        meanDamage: phase.meanDamage,
        modelsKilled: phase.modelsKilled,
        fractionDestroyed: Math.min(1, phase.meanDamage / Math.max(rep.referenceWounds, 1)),
      });
    }
    if (matchups.length === 0) {
      skipped.push(combatant.name);
      continue;
    }
    // Specialty = where it lands the most EFFECTIVE damage (size-independent),
    // with a small floor so a unit that barely scratches anything isn't tagged.
    const specialtyMatchup = matchups.reduce((best, m) => (m.meanDamage > best.meanDamage ? m : best));
    const specialty = specialtyMatchup.meanDamage >= 0.5 ? specialtyMatchup.key : null;
    // Biggest single threat = closest to removing a whole unit of mine.
    const bestMatchup = matchups.reduce((best, m) => (m.fractionDestroyed > best.fractionDestroyed ? m : best));
    profiles.push({
      attackerName: combatant.name,
      attackerPoints: combatant.points,
      multiplicity: combatant.multiplicity,
      matchups,
      specialty,
      bestMatchup,
    });
  }

  profiles.sort((a, b) => b.bestMatchup.fractionDestroyed - a.bestMatchup.fractionDestroyed);
  const topThreats = profiles.slice(0, 3);

  // Verdict: tally each unit's specialty, weighted by its points (so an
  // expensive anti-tank unit counts for more than a cheap chaff screen).
  const counts: Record<Archetype, number> = { dreadknight: 0, elite: 0, light: 0 };
  const pointsWeight: Record<Archetype, number> = { dreadknight: 0, elite: 0, light: 0 };
  for (const p of profiles) {
    if (!p.specialty) continue;
    counts[p.specialty] += 1;
    pointsWeight[p.specialty] += p.attackerPoints ?? 100;
  }
  const totalWeight = pointsWeight.dreadknight + pointsWeight.elite + pointsWeight.light;
  const weights: Record<Archetype, number> =
    totalWeight > 0
      ? {
          dreadknight: pointsWeight.dreadknight / totalWeight,
          elite: pointsWeight.elite / totalWeight,
          light: pointsWeight.light / totalWeight,
        }
      : { dreadknight: 0, elite: 0, light: 0 };

  const ordered = (Object.keys(weights) as Archetype[]).sort((a, b) => weights[b] - weights[a]);
  let leaning: ThreatVerdict["leaning"] = "balanced";
  if (totalWeight > 0) {
    const [first, second] = ordered;
    if (weights[first] > weights[second] * LEANING_BAND) leaning = first;
  }

  const archetypes = reps.map((r) => ({
    key: r.key,
    label: ARCHETYPE_LABEL[r.key],
    repName: r.repName,
    wounds: r.referenceWounds,
    models: r.referenceModels,
  }));

  return { archetypes, profiles, topThreats, verdict: { leaning, weights, counts }, skipped };
}
