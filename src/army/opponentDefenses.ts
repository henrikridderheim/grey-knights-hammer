/**
 * Detecting and applying an opponent unit's datasheet defensive abilities when
 * building it as a TARGET for the "best way to kill it" / counter analysis.
 *
 * The base target is built from the statline (T/Sv/Inv/W). These helpers add a
 * couple of common, damage-relevant rules the statline alone can't express:
 *   - Rugged Resilience: -1 to wound when the attack's S > this unit's T
 *     (applied by the engine via TargetUnit.ruggedResilience).
 *   - Storm Shield: raises the Wounds characteristic of the models carrying one
 *     (split out into a higher-Wounds sub-group).
 */

import type { DefenseModelGroup } from "../engine/types";
import type { NormalizedUnit } from "../parser/types";
import type { ParsedWargearLine } from "../parser/parseArmyList";

/** Rugged Resilience: -1 to wound when attacker S > this unit's T. Detected by
 * datasheet ability name so it applies to any unit that has it. */
export function hasRuggedResilience(sheet: NormalizedUnit): boolean {
  return sheet.abilities.some((a) => /rugged\s+resilience/i.test(a.name));
}

/** Storm Shield wargear: "The bearer has a Wounds characteristic of N." Returns
 * the shield-bearer Wounds value and how many models carry one (from the parsed
 * wargear), or null if the unit has no such ability / no shields listed. */
export function stormShieldInfo(
  sheet: NormalizedUnit,
  wargear: ParsedWargearLine[]
): { shieldWounds: number; count: number } | null {
  const ability = sheet.abilities.find((a) => /storm\s+shield/i.test(a.name));
  if (!ability) return null;
  const m = ability.text.match(/wounds\s+characteristic\s+of\s+(\d+)/i);
  if (!m) return null;
  const shieldWounds = Number(m[1]);
  const count = wargear
    .filter((w) => /storm\s+shield/i.test(w.rawText))
    .reduce((sum, w) => sum + (w.count ?? 1), 0);
  return count > 0 ? { shieldWounds, count } : null;
}

/** Model groups for one unit, splitting Storm-Shield-bearing models into a
 * higher-Wounds sub-group — but only when the shield actually raises Wounds
 * (so it never lowers a tougher model, and units without it are unchanged). */
export function buildDefenseGroups(
  sheet: NormalizedUnit,
  label: string,
  count: number,
  wargear: ParsedWargearLine[],
  isAttachedCharacter?: boolean
): DefenseModelGroup[] {
  const base: DefenseModelGroup = {
    label,
    count,
    toughness: sheet.statline.toughness,
    save: sheet.statline.save,
    invulnSave: sheet.statline.invulnSave,
    wounds: sheet.statline.wounds,
    isAttachedCharacter,
  };
  const ss = stormShieldInfo(sheet, wargear);
  if (!ss || ss.shieldWounds <= base.wounds) return [base];
  const shields = Math.min(ss.count, count);
  const remainder = count - shields;
  const groups: DefenseModelGroup[] = [];
  if (remainder > 0) groups.push({ ...base, count: remainder });
  groups.push({ ...base, label: `${label} (Storm Shield)`, count: shields, wounds: ss.shieldWounds });
  return groups;
}

// --- General defensive-ability recognizer -------------------------------------

export type DefensiveEffect =
  | { kind: "feelNoPain"; value: number }
  | { kind: "hitPenalty" } // -1 to be hit (ranged)
  | { kind: "woundPenalty" } // unconditional -1 to be wounded
  | { kind: "reduceDamage"; value: number }
  | { kind: "ruggedResilience" } // -1 to wound when attacker S > this unit's T
  | { kind: "stormShieldWounds"; wounds: number; count: number };

export interface DetectedAbility {
  id: string;
  label: string;
  /** The datasheet ability / wargear this came from. */
  source: string;
  effect: DefensiveEffect;
  /** Wording suggests a condition we can't verify (e.g. "against mortal wounds",
   * "if it Remained Stationary") — surfaced so the user can review/override. */
  conditional: boolean;
}

export interface DefenseDetection {
  detected: DetectedAbility[];
  /** Abilities that look damage-relevant but we couldn't confidently model. */
  unmodeled: string[];
}

// The dataset's per-unit `abilities` list is polluted with a faction-wide
// shared pool (detachment rules, enhancements, other units' abilities), so
// free-text scanning would produce false positives. We exclude any ability
// that appears across a large fraction of the faction's units — a unit's OWN
// abilities are rare, the shared pool is not. Populated once per parse from the
// loaded faction data (see parseArmyList) via setSharedAbilityPool.
let sharedAbilityPool: ReadonlySet<string> = new Set();
export function setSharedAbilityPool(names: Iterable<string>): void {
  sharedAbilityPool = new Set(names);
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Is one of an optional ability's providing upgrades actually taken in the army
 * list? An upgrade is "taken" if it's the unit's chosen enhancement, or it
 * matches a wargear line (the export prints taken wargear, e.g. "1x Nullstone
 * Field Generator (Aura)"). Names are compared ignoring case/punctuation, and a
 * wargear line may add a suffix to the upgrade's name ("... (Aura)"). */
export function isOptionSelected(
  options: readonly string[],
  wargear: readonly ParsedWargearLine[],
  enhancement?: string | null
): boolean {
  const enh = enhancement ? normName(enhancement) : "";
  const lines = wargear.flatMap((w) => [w.rawText, w.matchedWeaponName]).filter((x): x is string => !!x).map(normName);
  return options.some((opt) => {
    const o = normName(opt);
    if (!o) return false;
    if (enh && enh === o) return true;
    return lines.some((n) => n === o || n.startsWith(o) || (n.length >= 8 && o.startsWith(n)));
  });
}

/** Hints that an ability only applies in a specific, unverifiable situation. */
const CONDITION_HINT =
  /(against|remained stationary|mortal wound|more than \d|within \d|below (half|starting)|each time this unit is selected as the target of a psychic)/i;

/** Text that describes penalties on attacks MADE by a model, with nothing saying
 * the attacks are made AGAINST this unit — e.g. "each time a model in that unit
 * makes an attack, subtract 1 from the Hit roll" (a debuff this unit puts on a
 * selected enemy, like Animus Damper) or "while this model has 1-4 wounds
 * remaining, each time this model makes an attack, subtract 1 from the Hit roll"
 * (the model's own damaged-profile penalty). Neither protects this unit from
 * incoming attacks, so neither may be applied as a -1 to be hit / -1 to be
 * wounded. Wording that says attacks "target" / "are made against" this unit
 * is a real defence and is never treated as offensive-only. */
function isOffensiveOnly(text: string): boolean {
  const defends =
    /attacks?\s+(?:that\s+)?targets?\s+(?:this|that|the bearer|it\b)|attacks?\s+(?:is|are)\s+made\s+against\s+(?:this|that|the bearer)/i.test(
      text
    );
  if (defends) return false;
  return /\b(?:makes?|made)\s+(?:an?\s+)?attacks?\b/i.test(text);
}

function isDefensiveRelevant(text: string): boolean {
  return /(wound roll|hit roll|feel no pain|damage characteristic|invulnerable|saving throw|cannot be wounded|reduce the damage|halve the damage)/i.test(
    text
  );
}

/** Scan a unit's datasheet abilities (and wargear) for common, damage-relevant
 * DEFENSIVE rules, mapping each to a typed engine effect. Conservative by
 * design: anything with wording we can't confidently model is returned in
 * `unmodeled` for the user to see, not silently applied. */
export function detectDefensiveAbilities(
  sheet: NormalizedUnit,
  wargear: ParsedWargearLine[],
  enhancement?: string | null
): DefenseDetection {
  const detected: DetectedAbility[] = [];
  const unmodeled: string[] = [];
  const seen = new Set<string>();
  const add = (effect: DefensiveEffect, label: string, source: string, conditional: boolean) => {
    const id = `${sheet.id}:${effect.kind}`;
    if (seen.has(id)) {
      // One of each effect kind per unit — except Feel No Pain, where a better
      // (lower) unconditional value found later replaces a worse one.
      if (effect.kind !== "feelNoPain" || conditional) return;
      const i = detected.findIndex((d) => d.id === id);
      const cur = detected[i];
      if (cur && cur.effect.kind === "feelNoPain" && effect.value < cur.effect.value) {
        detected[i] = { id, label, source, effect, conditional };
      }
      return;
    }
    seen.add(id);
    detected.push({ id, label, source, effect, conditional });
  };

  // Core abilities (Feel No Pain N+, Stealth, ...). These come from the data
  // pipeline's `coreAbilities` list, NOT from `abilities` — the source data
  // stores them as links to core rules, so they never appear as ability text.
  // They're the unit's own printed rules (not the faction-wide shared pool), so
  // they're read first and are never excluded by `sharedAbilityPool`.
  for (const core of sheet.coreAbilities ?? []) {
    const fnpCore = core.match(/^feel no pain\s*(\d)\+$/i);
    if (fnpCore) {
      add({ kind: "feelNoPain", value: Number(fnpCore[1]) }, `Feel No Pain ${fnpCore[1]}+ (core ability)`, "Core ability", false);
    } else if (/^stealth$/i.test(core)) {
      add({ kind: "hitPenalty" }, "-1 to be hit (ranged) — Stealth (core ability)", "Core ability: Stealth", false);
    }
  }

  for (const a of sheet.abilities) {
    // Skip the faction-wide shared pool (see sharedAbilityPool) — those aren't
    // reliably this unit's own abilities. Storm Shield is handled separately
    // below via wargear, so excluding it here doesn't lose it.
    if (sharedAbilityPool.has(a.name)) continue;
    // An ability that only exists as part of an optional upgrade (an
    // enhancement, a wargear option) is the unit's only if the list takes it —
    // the datasheet lists every option a player *could* take, so without this a
    // C'tan that didn't take Animus Damper would still get its effects.
    if (a.options && !isOptionSelected(a.options, wargear, enhancement)) continue;
    const t = a.text;
    let matched = false;
    const offensiveOnly = isOffensiveOnly(t);

    // Rugged Resilience (conditional -1 to wound when S > T) — checked before the
    // generic -1-to-wound so it isn't mistaken for an unconditional penalty.
    if (
      /rugged\s+resilience/i.test(a.name) ||
      (/subtract 1 from the wound roll/i.test(t) && /strength/i.test(t) && /greater than/i.test(t) && /toughness/i.test(t))
    ) {
      add({ kind: "ruggedResilience" }, "Rugged Resilience (-1 to wound if S > T)", a.name, false);
      matched = true;
    } else if (!offensiveOnly && /subtract 1 from the wound roll/i.test(t)) {
      add({ kind: "woundPenalty" }, "-1 to be wounded", a.name, CONDITION_HINT.test(t));
      matched = true;
    }

    const fnp = t.match(/feel no pain\s*(\d)\+/i);
    if (fnp) {
      add({ kind: "feelNoPain", value: Number(fnp[1]) }, `Feel No Pain ${fnp[1]}+`, a.name, CONDITION_HINT.test(t));
      matched = true;
    }

    if (/^stealth$/i.test(a.name) || (!offensiveOnly && /subtract 1 from the hit roll/i.test(t))) {
      add({ kind: "hitPenalty" }, "-1 to be hit (ranged)", a.name, CONDITION_HINT.test(t) && !/stealth/i.test(a.name));
      matched = true;
    }

    if (
      /subtract 1 from the damage/i.test(t) ||
      /reduce the damage characteristic[^.]*by 1/i.test(t) ||
      /worsen the damage characteristic[^.]*by 1/i.test(t)
    ) {
      add({ kind: "reduceDamage", value: 1 }, "-1 to incoming Damage", a.name, CONDITION_HINT.test(t));
      matched = true;
    }

    if (!matched && !offensiveOnly && isDefensiveRelevant(t)) unmodeled.push(a.name);
  }

  const ss = stormShieldInfo(sheet, wargear);
  if (ss && ss.shieldWounds > sheet.statline.wounds) {
    detected.push({
      id: `${sheet.id}:stormShieldWounds`,
      label: `Storm Shield (W${ss.shieldWounds} on ${ss.count})`,
      source: "Storm Shield",
      effect: { kind: "stormShieldWounds", wounds: ss.shieldWounds, count: ss.count },
      conditional: false,
    });
  }

  return { detected, unmodeled };
}

export interface UnitDefense {
  groups: DefenseModelGroup[];
  ruggedResilience: boolean;
  incoming: { hitPenalty: number; woundPenalty: number; damageReduction: number };
  detected: DetectedAbility[];
  unmodeled: string[];
}

/** One unit's full defensive profile — model groups (Storm-Shield Wounds split
 * + Feel No Pain) plus the incoming-attack modifiers — applying every detected
 * ability that isn't in `disabled`. */
export function buildUnitDefense(
  sheet: NormalizedUnit,
  label: string,
  count: number,
  wargear: ParsedWargearLine[],
  disabled: ReadonlySet<string>,
  isAttachedCharacter?: boolean,
  enhancement?: string | null
): UnitDefense {
  const { detected, unmodeled } = detectDefensiveAbilities(sheet, wargear, enhancement);
  const active = detected.filter((d) => !disabled.has(d.id));

  const fnpEffect = active.find((d) => d.effect.kind === "feelNoPain")?.effect;
  const feelNoPain = fnpEffect && fnpEffect.kind === "feelNoPain" ? fnpEffect.value : undefined;
  const ssEffect = active.find((d) => d.effect.kind === "stormShieldWounds")?.effect;

  const base: DefenseModelGroup = {
    label,
    count,
    toughness: sheet.statline.toughness,
    save: sheet.statline.save,
    invulnSave: sheet.statline.invulnSave,
    wounds: sheet.statline.wounds,
    feelNoPain,
    isAttachedCharacter,
  };

  let groups: DefenseModelGroup[];
  if (ssEffect && ssEffect.kind === "stormShieldWounds" && ssEffect.wounds > base.wounds) {
    const shields = Math.min(ssEffect.count, count);
    const remainder = count - shields;
    groups = [];
    if (remainder > 0) groups.push({ ...base, count: remainder });
    groups.push({ ...base, label: `${label} (Storm Shield)`, count: shields, wounds: ssEffect.wounds });
  } else {
    groups = [base];
  }

  const incoming = {
    hitPenalty: active.some((d) => d.effect.kind === "hitPenalty") ? 1 : 0,
    woundPenalty: active.some((d) => d.effect.kind === "woundPenalty") ? 1 : 0,
    damageReduction: active.reduce((s, d) => (d.effect.kind === "reduceDamage" ? s + d.effect.value : s), 0),
  };
  const ruggedResilience = active.some((d) => d.effect.kind === "ruggedResilience");

  return { groups, ruggedResilience, incoming, detected, unmodeled };
}
