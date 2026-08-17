import { useEffect, useRef, useState } from "react";
import "./App.css";
import {
  DEFAULT_DEFENSIVE_SETTINGS,
  type DefenseModelGroup,
  type DefensiveSettings,
  type SimulationSummary,
  type TargetUnit,
} from "./engine/types";
import {
  computeBestWayToKillIt,
  sortOptions,
  type BestWayToKillItResult,
  type RankedOption,
  type SortKey,
  type WeaponBreakdownRow,
} from "./army/bestWayToKillIt";
import { ARMY_TOTAL_POINTS, ROSTER, type UnitDefinition } from "./army/roster";
import { computeTopCounters, computeUnitCounterEntry, type CounterRankedUnit } from "./army/counterMatchups";
import {
  DEFAULT_DAMAGE_SETTINGS,
  eligibleStratagemKeys,
  unitScenarios,
  buildEngagementsForScenario,
  type DamageSettings,
} from "./army/engagementBuilder";
import { computeOptimalSequencing, type SequencingResult } from "./army/sequencing";
import { computeThreatAnalysis, type ThreatAnalysisResult, type ThreatVerdict } from "./army/threatAnalysis";
import {
  parseArmyList,
  type AttachedGroup,
  type ParseArmyListResult,
  type ParsedUnit,
} from "./parser/parseArmyList";
import {
  buildUnitDefense,
  detectDefensiveAbilities,
  setSharedAbilityPool,
  type DetectedAbility,
} from "./army/opponentDefenses";
import { createFetchDatasheetProvider } from "./parser/fetchDatasheetProvider";

const datasheetProvider = createFetchDatasheetProvider();

interface TargetFormState {
  name: string;
  count: number;
  toughness: number;
  save: number;
  invulnSave: number | "";
  wounds: number;
  feelNoPain: number | "";
  hasCover: boolean;
  isInfantry: boolean;
}

const DEFAULT_FORM: TargetFormState = {
  name: "Enemy Unit",
  count: 5,
  toughness: 4,
  save: 3,
  invulnSave: "",
  wounds: 2,
  feelNoPain: "",
  hasCover: false,
  isInfantry: true,
};

function formToTarget(form: TargetFormState): TargetUnit {
  return {
    name: form.name || "Enemy Unit",
    isAttached: false,
    hasCover: form.hasCover,
    modelCountForBlast: form.count,
    keywords: form.isInfantry ? ["INFANTRY"] : [],
    groups: [
      {
        label: form.name || "Enemy Unit",
        count: form.count,
        toughness: form.toughness,
        save: form.save,
        invulnSave: form.invulnSave === "" ? undefined : form.invulnSave,
        wounds: form.wounds,
        feelNoPain: form.feelNoPain === "" ? undefined : form.feelNoPain,
      },
    ],
  };
}

/** Best-effort default when the pasted list didn't state an explicit model count
 * for a unit (e.g. a single-model datasheet with no "1x ..." composition line
 * for the parser to find) — reads the real datasheet's composition text
 * ("1 model", "10-20 models", "10+ models", ...) instead of guessing a flat
 * number. Falls back to 5 only if the composition text itself has no digit. */
function defaultModelCountFromComposition(composition: string | undefined): number {
  const match = composition?.match(/\d+/);
  return match ? Number(match[0]) : 5;
}

const NO_DISABLED: ReadonlySet<string> = new Set();

/** A parsed opponent we can rebuild a target from when its ability toggles
 * change — a standalone unit or an attached (Leader+Bodyguard) group. */
type TargetSource = { kind: "unit"; unit: ParsedUnit } | { kind: "group"; group: AttachedGroup };

/** Detected defensive abilities for a source (merged across an attached group's
 * members), for the toggle UI. */
function detectForSource(source: TargetSource): { detected: DetectedAbility[]; unmodeled: string[] } {
  if (source.kind === "unit") {
    return source.unit.datasheet
      ? detectDefensiveAbilities(source.unit.datasheet, source.unit.wargear)
      : { detected: [], unmodeled: [] };
  }
  const detected: DetectedAbility[] = [];
  const seen = new Set<string>();
  const unmodeled = new Set<string>();
  for (const m of source.group.members) {
    if (!m.datasheet) continue;
    const d = detectDefensiveAbilities(m.datasheet, m.wargear);
    for (const a of d.detected) if (!seen.has(a.id)) (seen.add(a.id), detected.push(a));
    for (const u of d.unmodeled) unmodeled.add(u);
  }
  return { detected, unmodeled: [...unmodeled] };
}

function buildTargetFromSource(source: TargetSource, disabled: ReadonlySet<string>): TargetUnit | null {
  return source.kind === "unit"
    ? parsedUnitToTarget(source.unit, disabled)
    : attachedGroupToTarget(source.group, disabled);
}

function parsedUnitToTarget(unit: ParsedUnit, disabled: ReadonlySet<string> = NO_DISABLED): TargetUnit | null {
  const sheet = unit.datasheet;
  if (!sheet) return null;
  const name = unit.rawName || sheet.name;
  const count = unit.modelCount ?? defaultModelCountFromComposition(sheet.composition);
  const def = buildUnitDefense(sheet, name, count, unit.wargear, disabled);
  return {
    name,
    isAttached: false,
    hasCover: false,
    modelCountForBlast: count,
    keywords: sheet.keywords.map((k) => k.toUpperCase()),
    ruggedResilience: def.ruggedResilience,
    incoming: def.incoming,
    groups: def.groups,
  };
}

function isInfantryDatasheet(unit: ParsedUnit): boolean {
  return !!unit.datasheet?.keywords.some((k) => k.toUpperCase() === "INFANTRY");
}

/** One Leader (+ optional Support) attached to one Bodyguard unit is a single
 * unit for almost all 11e rules purposes — targeting, wound allocation, Blast
 * model count, ... — so it's modeled as one combined TargetUnit rather than
 * evaluating the Leader and Bodyguard as separate targets. The Bodyguard
 * becomes the main (non-character) group; each Leader/Support becomes its own
 * `isAttachedCharacter` group, matching the engine's existing support for
 * "Character in an Attached unit can't be allocated normal damage, only
 * Precision" and "wound rolls use the highest Toughness among Bodyguard
 * models" (both verified against the live 11e core rules). */
function attachedGroupToTarget(group: AttachedGroup, disabled: ReadonlySet<string> = NO_DISABLED): TargetUnit | null {
  const bodyguard = group.members.find((m) => m.attachedRole === "bodyguard" && m.datasheet);
  if (!bodyguard?.datasheet) return null;
  // Safety net: dedupe attached characters by datasheet so a group can never
  // render the same leader twice (you can't attach two of the same character to
  // one unit — if a parse ever produced a duplicate, it'd be a bug, not a real
  // list). Also drop any character that's actually the bodyguard entry.
  const seenChar = new Set<string>();
  const characters = group.members.filter((m) => {
    if (m.attachedRole === "bodyguard" || !m.datasheet || m === bodyguard) return false;
    const sig = m.matchedUnitId ?? m.rawName;
    if (seenChar.has(sig)) return false;
    seenChar.add(sig);
    return true;
  });

  const bodyguardCount = bodyguard.modelCount ?? defaultModelCountFromComposition(bodyguard.datasheet.composition);
  const bgDef = buildUnitDefense(bodyguard.datasheet, bodyguard.rawName, bodyguardCount, bodyguard.wargear, disabled);
  const groups: DefenseModelGroup[] = [...bgDef.groups];
  let totalModels = bodyguardCount;
  let ruggedResilience = bgDef.ruggedResilience;
  const incoming = { ...bgDef.incoming };
  for (const ch of characters) {
    if (!ch.datasheet) continue;
    const count = ch.modelCount ?? defaultModelCountFromComposition(ch.datasheet.composition);
    totalModels += count;
    const chDef = buildUnitDefense(ch.datasheet, ch.rawName, count, ch.wargear, disabled, true);
    groups.push(...chDef.groups);
    // A defensive ability held by any member applies to the whole combined
    // unit; take the strongest of each (they don't stack).
    ruggedResilience = ruggedResilience || chDef.ruggedResilience;
    incoming.hitPenalty = Math.max(incoming.hitPenalty, chDef.incoming.hitPenalty);
    incoming.woundPenalty = Math.max(incoming.woundPenalty, chDef.incoming.woundPenalty);
    incoming.damageReduction = Math.max(incoming.damageReduction, chDef.incoming.damageReduction);
  }
  const name = [bodyguard.rawName, ...characters.map((c) => c.rawName)].join(" + ");
  // Anti-X keyword gating uses the Bodyguard's own keywords (the unit's
  // majority profile) — the attached Character(s) may have different
  // keywords, but per-model keyword mixing isn't modeled here.
  const keywords = bodyguard.datasheet.keywords.map((k) => k.toUpperCase());
  return { name, isAttached: true, hasCover: false, modelCountForBlast: totalModels, keywords, ruggedResilience, incoming, groups };
}

/** A single thing to run "best way to kill it" against — either one standalone
 * parsed unit or one combined attached (Leader+Bodyguard) group. `formSeed` is
 * the ParsedUnit to populate the manual form from when the user wants to
 * tweak it by hand — null for attached groups, which don't fit the manual
 * form's single-group model. */
interface AnalysisTarget {
  key: string; // dedupe signature
  label: string;
  points: number | null;
  target: TargetUnit;
  formSeed: ParsedUnit | null;
  /** Parsed source, so the target can be rebuilt when ability toggles change. */
  source: TargetSource;
  /** Auto-detected defensive abilities + the ones we couldn't model, for the UI. */
  detected: DetectedAbility[];
  unmodeled: string[];
}

interface AutoUnitResult {
  key: string;
  label: string;
  target: TargetUnit;
  formSeed: ParsedUnit | null;
  outcome: BestWayToKillItResult;
  /** How many identical copies of this unit/group (same datasheet(s), size(s),
   * wargear) appeared in the pasted list — shown once, not repeated. */
  multiplicity: number;
  source: TargetSource;
  detected: DetectedAbility[];
  unmodeled: string[];
}

interface CounterUnitResult {
  key: string;
  label: string;
  points: number | null;
  target: TargetUnit;
  shooting: CounterRankedUnit[];
  melee: CounterRankedUnit[];
  multiplicity: number;
  source: TargetSource;
  detected: DetectedAbility[];
  unmodeled: string[];
}

interface SequencingCacheEntry {
  loading: boolean;
  result: SequencingResult | null;
}

/** Groups identical repeated units (e.g. "4x10 Poxwalkers" as four separate list
 * entries) so they're analyzed and shown once instead of as duplicate blocks. */
function unitDedupeSignature(unit: ParsedUnit): string {
  const count = unit.modelCount ?? defaultModelCountFromComposition(unit.datasheet?.composition);
  const wargearSig = unit.wargear
    .map((w) => `${w.matchedWeaponName ?? w.rawText}x${w.count ?? 1}`)
    .sort()
    .join(",");
  return `${unit.matchedUnitId}|${count}|${wargearSig}|${unit.enhancement ?? ""}`;
}

function attachedGroupDedupeSignature(group: AttachedGroup): string {
  return group.members
    .map((m) => `${m.attachedRole}:${unitDedupeSignature(m)}`)
    .sort()
    .join("||");
}

const STRATAGEM_TOGGLE_LABELS: Record<keyof DamageSettings, string> = {
  furyOfTitan: "Fury of Titan (free — re-roll Hit/Wound roll of 1, deep struck this turn)",
  purgationPattern: "Purgation Pattern (1CP — Sustained Hits 1, deep struck & hasn't shot yet)",
  truesilverChannelling: "Truesilver Channelling (2CP — Devastating Wounds, fighting)",
  focusedImmolation: "Focused Immolation (1CP — Devastating Wounds + Sustained Hits 1, after shooting)",
  nearObjective: "Near objective (Sanctity of Purpose: re-roll all failed Wounds, not just a 1)",
};

/** A unit's own eligible stratagem/rule toggles — only the ones it's
 * actually eligible for (per `eligibleStratagemKeys`), so an ineligible
 * toggle is never shown rather than shown disabled. Name-less: for embedding
 * inline under a unit that's already named elsewhere (one row of a matchup
 * card). */
function InlineStratagemToggles({
  unit,
  settings,
  onToggle,
}: {
  unit: UnitDefinition;
  settings: DamageSettings;
  onToggle: (key: keyof DamageSettings, value: boolean) => void;
}) {
  const keys = eligibleStratagemKeys(unit);
  if (keys.length === 0) return null;
  return (
    <div className="inline-stratagem-toggles">
      {keys.map((key) => (
        <label className="checkbox-row" key={key}>
          <input type="checkbox" checked={settings[key]} onChange={(e) => onToggle(key, e.target.checked)} />
          {STRATAGEM_TOGGLE_LABELS[key]}
        </label>
      ))}
    </div>
  );
}

const DEFENSIVE_TOGGLE_LABELS: Record<keyof DefensiveSettings, string> = {
  minusOneToWound: "-1 to Wound (min 2+ needed)",
  minusOneToDamage: "-1 to Damage (min 1 per attack)",
  minusOneToAP: "-1 to AP (min AP0)",
};

/** This opponent unit's own defensive rules — reduces every incoming attack
 * against it, from any of my units, in either phase (one shared toggle set
 * per opponent unit, not per attacker or per phase). Not gated by
 * eligibility like the offensive toggles are: we don't have per-opponent-unit
 * ability data to check against, so these generic 10e/11e-style rules are
 * offered to every target — flagged here so it's clear that's an assumption,
 * not a claim that a specific unit actually has one of these abilities. */
function DefensiveToggleRow({
  settings,
  onToggle,
}: {
  settings: DefensiveSettings;
  onToggle: (key: keyof DefensiveSettings, value: boolean) => void;
}) {
  return (
    <div className="inline-stratagem-toggles defensive-toggle-row">
      <span className="defensive-toggle-label">Defensive (any of my attacks against this unit):</span>
      {(Object.keys(DEFENSIVE_TOGGLE_LABELS) as (keyof DefensiveSettings)[]).map((key) => (
        <label className="checkbox-row" key={key}>
          <input type="checkbox" checked={settings[key]} onChange={(e) => onToggle(key, e.target.checked)} />
          {DEFENSIVE_TOGGLE_LABELS[key]}
        </label>
      ))}
    </div>
  );
}

/** Manual half-range toggle for a whole calculation card — forces the
 * Rapid Fire / Melta range band on (half range) or off (full range) instead
 * of the app auto-showing both bands as separate options. Shooting-only:
 * melee is range-agnostic, so this row is never rendered in melee sections.
 * Styled as its own group, distinct from the offensive and defensive toggles,
 * so it's clear it's a range setting. */
function HalfRangeToggleRow({
  value,
  onToggle,
}: {
  value: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <div className="inline-stratagem-toggles half-range-toggle-row">
      <label className="checkbox-row">
        <input type="checkbox" checked={value} onChange={(e) => onToggle(e.target.checked)} />
        Half range (Rapid Fire / Melta bonus)
      </label>
    </div>
  );
}

/** Auto-detected opponent defensive abilities, shown as pre-checked toggles so
 * the user can switch off any that were mis-detected or don't apply, plus a
 * note of abilities we spotted but couldn't model. */
function DefensiveAbilityToggles({
  detected,
  unmodeled,
  disabled,
  onToggle,
}: {
  detected: DetectedAbility[];
  unmodeled: string[];
  disabled: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (detected.length === 0 && unmodeled.length === 0) return null;
  return (
    <div className="inline-stratagem-toggles ability-toggle-row">
      {detected.length > 0 && (
        <>
          <span className="defensive-toggle-label">Detected abilities (auto-applied to this unit):</span>
          {detected.map((a) => (
            <label className="checkbox-row" key={a.id} title={a.source}>
              <input type="checkbox" checked={!disabled.has(a.id)} onChange={() => onToggle(a.id)} />
              {a.label}
              {a.conditional && <span className="conditional-badge">check condition</span>}
            </label>
          ))}
        </>
      )}
      {unmodeled.length > 0 && (
        <span className="section-note ability-unmodeled">Not modelled (check manually): {unmodeled.join(", ")}</span>
      )}
    </div>
  );
}

/** Total wounds across every model in the target — the "expected result"
 * needed to fully wipe it, shown as the reference point in the Final Damage
 * breakdown. */
function targetTotalWounds(target: TargetUnit): number {
  return target.groups.reduce((sum, g) => sum + g.wounds * g.count, 0);
}

/** Renders the "Final Damage" breakdown — target wounds vs. this option's
 * damage distribution — matching the summary format from the reference
 * mathhammer tool the user compared against. */
function FinalDamageBreakdown({ summary, totalWounds }: { summary: SimulationSummary; totalWounds: number }) {
  const fillPct = Math.max(0, Math.min(100, (summary.meanDamage / Math.max(totalWounds, 1)) * 100));
  return (
    <div className="final-damage">
      <div className="final-damage-title">
        <span>Final Damage</span>
        <span>{totalWounds}</span>
      </div>
      <div className="final-damage-bar-track">
        <div className="final-damage-bar-fill" style={{ width: `${fillPct}%` }} />
      </div>
      <div className="final-damage-rows">
        <div>
          <span>
            Expected result <span className="hint" title="Total wounds across every model in the target unit">?</span>
          </span>
          <span>{totalWounds}</span>
        </div>
        <div>
          <span>Chance of full kill</span>
          <span>{(summary.killProbability * 100).toFixed(1)}%</span>
        </div>
        <div>
          <span>Mean</span>
          <span>{summary.meanDamage.toFixed(1)}</span>
        </div>
        <div>
          <span>Mode</span>
          <span>{summary.modeDamage}</span>
        </div>
        <div>
          <span>
            Standard deviation <span className="hint" title="How spread out the damage results are around the mean">?</span>
          </span>
          <span>{summary.stdDevDamage.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}

/** Per-weapon attack-sequence breakdown, laid out the same way as the
 * reference mathhammer tool's "Weapon Results" tab: Weapon | Attacks | Hits
 * | Wounds Dealt | Unsaved Wounds | Damage Dealt, one row per weapon. */
function WeaponBreakdownTable({ rows }: { rows: WeaponBreakdownRow[] }) {
  return (
    <div className="weapon-breakdown-table">
      <div className="weapon-breakdown-row weapon-breakdown-header">
        <span>Weapon</span>
        <span>Attacks</span>
        <span>Hits</span>
        <span>Wounds Dealt</span>
        <span>Unsaved Wounds</span>
        <span>Damage Dealt</span>
      </div>
      {rows.map((w, wi) => (
        <div className="weapon-breakdown-row" key={wi}>
          <span>{w.label}</span>
          <span>{w.attacks.toFixed(2)}</span>
          <span>{w.hits.toFixed(2)}</span>
          <span>{w.woundsDealt.toFixed(2)}</span>
          <span>{w.unsavedWounds.toFixed(2)}</span>
          <span>{w.avg.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

/** "What order should I fire this unit's weapons in" — on-demand (button
 * triggered, not auto-computed, since it's a permutation search) comparison
 * of the best-found firing order against the naive/default order, so the
 * user can see the actual overkill-avoidance improvement sequencing gives. */
function SequencingPanel({
  entry,
  onCompute,
}: {
  entry: SequencingCacheEntry | undefined;
  onCompute: () => void;
}) {
  return (
    <div className="sequencing-panel">
      <div className="section-note">
        Sequencing: which order you resolve this unit's weapon profiles in can change how much damage is wasted to
        overkill (excess damage from a single attack doesn't carry to another model) — a low-shot/high-damage weapon
        wasted on a model something else is about to finish off loses value; fired into a fresh model it doesn't.
        Probabilistic/expected-value recommendation from simulating every firing order, not a guaranteed outcome.
      </div>
      {!entry && (
        <button
          className="use-target-btn"
          onClick={(e) => {
            e.stopPropagation();
            onCompute();
          }}
        >
          Calculate optimal sequencing
        </button>
      )}
      {entry?.loading && <div className="loading-state">Searching firing orders…</div>}
      {entry?.result && !entry.loading && !entry.result.applicable && (
        <div className="section-note">Only one distinct weapon profile here — nothing to sequence.</div>
      )}
      {entry?.result && !entry.loading && entry.result.applicable && (
        <>
          <div className="sequencing-order">
            <span className="sequencing-order-title">Recommended order</span>
            <ol>
              {entry.result.optimalOrder.map((label, i) => (
                <li key={i}>{label}</li>
              ))}
            </ol>
            <div className="option-stats">
              <div>
                <span className="stat-value">{entry.result.optimalMeanDamage.toFixed(1)}</span> avg dmg
              </div>
              <div>
                <span className="stat-value">{entry.result.optimalMeanModelsKilled.toFixed(2)}</span> models killed
              </div>
            </div>
          </div>
          <div className="sequencing-order">
            <span className="sequencing-order-title">Naive order (as listed above)</span>
            <ol>
              {entry.result.naiveOrder.map((label, i) => (
                <li key={i}>{label}</li>
              ))}
            </ol>
            <div className="option-stats">
              <div>
                <span className="stat-value">{entry.result.naiveMeanDamage.toFixed(1)}</span> avg dmg
              </div>
              <div>
                <span className="stat-value">{entry.result.naiveMeanModelsKilled.toFixed(2)}</span> models killed
              </div>
            </div>
          </div>
          {entry.result.optimalMeanDamage > entry.result.naiveMeanDamage && (
            <div className="section-note">
              +{(entry.result.optimalMeanDamage - entry.result.naiveMeanDamage).toFixed(1)} dmg (
              {(
                (entry.result.optimalMeanDamage / Math.max(entry.result.naiveMeanDamage, 0.01) - 1) *
                100
              ).toFixed(0)}
              %) recovered from overkill by sequencing correctly.
            </div>
          )}
          {entry.result.usedGreedyFallback && (
            <div className="section-note">
              This unit has many distinct weapon profiles — using a fast approximate search instead of checking
              every possible order.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A top-level page section that can be collapsed to just its header — used
 * for every major results block so the page isn't one endless scroll. Each
 * instance owns its own open/closed state (uncontrolled): collapsing
 * "Opponent matchups — Melee" never affects any other section, and a section
 * resets to its `defaultOpen` state if it unmounts (e.g. re-pasting a list
 * empties `autoResults`/`counterResults` briefly, so the section disappears
 * and reappears fresh) and remounts. */
function CollapsibleCard({
  title,
  defaultOpen,
  badge,
  children,
}: {
  title: React.ReactNode;
  defaultOpen: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card">
      <div className="card-header" onClick={() => setOpen((o) => !o)}>
        <h2>{title}</h2>
        <div className="card-header-right">
          {badge}
          <span className={`collapse-caret${open ? " open" : ""}`}>▸</span>
        </div>
      </div>
      {open && children}
    </section>
  );
}

/** One opponent unit from the pasted list, with the top 3 of my units that
 * counter it best in ONE phase (Shooting or Melee, picked by the caller) —
 * in the same option-card style as the main ranked-options list. Each row's
 * stratagem/rule toggles are scoped to THIS specific (opponent unit, phase,
 * my unit) calculation — toggling one never affects that same my-unit's row
 * in a different opponent's card, or in the other phase's section. */
function CounterUnitBlock({
  result,
  counters,
  mode,
  getCalcSettings,
  onToggleCalcStratagem,
  defensiveSettings,
  onToggleDefensive,
  halfRange,
  onToggleHalfRange,
  disabledAbilities,
  onToggleAbility,
}: {
  result: CounterUnitResult;
  counters: CounterRankedUnit[];
  mode: "shooting" | "melee";
  getCalcSettings: (opponentKey: string, mode: "shooting" | "melee", unitId: string) => DamageSettings;
  onToggleCalcStratagem: (
    opponentKey: string,
    mode: "shooting" | "melee",
    unitId: string,
    key: keyof DamageSettings,
    value: boolean
  ) => void;
  defensiveSettings: DefensiveSettings;
  onToggleDefensive: (key: keyof DefensiveSettings, value: boolean) => void;
  /** Half-range toggle — only wired for the Shooting section; omitted in
   * Melee, where range doesn't apply. */
  halfRange?: boolean;
  onToggleHalfRange?: (value: boolean) => void;
  disabledAbilities: ReadonlySet<string>;
  onToggleAbility: (id: string) => void;
}) {
  return (
    <div className="auto-unit-block">
      <div className="auto-unit-header">
        <span className="option-name">
          {result.label}
          {result.multiplicity > 1 && <span className="multiplicity-badge">×{result.multiplicity} in list</span>}
        </span>
        {result.points != null && <span className="option-scenario">{result.points}pts</span>}
      </div>
      <div className="section-note">{formatTargetStatline(result.target)}</div>
      <DefensiveAbilityToggles
        detected={result.detected}
        unmodeled={result.unmodeled}
        disabled={disabledAbilities}
        onToggle={onToggleAbility}
      />
      <DefensiveToggleRow settings={defensiveSettings} onToggle={onToggleDefensive} />
      {mode === "shooting" && onToggleHalfRange && (
        <HalfRangeToggleRow value={!!halfRange} onToggle={onToggleHalfRange} />
      )}
      {counters.length === 0 && <div className="empty-state">No viable attack options found.</div>}
      {counters.map((c, i) => {
        const unit = (ROSTER as UnitDefinition[]).find((u) => u.id === c.unitId);
        return (
          <div className="counter-row" key={i}>
            <div className="auto-option-row">
              <span>
                {i + 1}. <span className="my-unit-name">{c.unitName}</span>{" "}
                <span className="section-note">({c.scenarioLabel})</span>
              </span>
              <span className="kill-good">
                {c.damage.toFixed(1)} dmg · {c.unitPoints}pts · {c.dmgPerPoint.toFixed(3)} dmg/pt
              </span>
            </div>
            <div className="section-note">~{c.modelsKilled.toFixed(2)} enemy models killed</div>
            {unit && (
              <InlineStratagemToggles
                unit={unit}
                settings={getCalcSettings(result.key, mode, unit.id)}
                onToggle={(key, value) => onToggleCalcStratagem(result.key, mode, unit.id, key, value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The auto-results quick view always shows a shooting option for these
 * specific units, in this order, regardless of how they currently rank by
 * kill% — a fixed roster reference instead of a "top N by kill%" heuristic,
 * so the same units are comparable target-to-target and the cheap Purgation
 * squads never get crowded out by the Crowe brick or GMND. Each entry is a
 * group of roster ids treated as one slot (only the best-performing id in
 * the group is shown) — GMND appears 3 times in the roster (Warlord + 2
 * plain copies, near-identical statlines) and would otherwise print as 3
 * duplicate rows; the two Purgation 5 squads have genuinely different
 * loadouts, so they're kept as separate slots. Now that every option's
 * stratagem toggles are interactive (see InlineStratagemToggles), there's no
 * need to auto-surface a "with vs. without the stratagem" pair anymore — the
 * user can just flip the toggle themselves.
 * Whichever combination of units is needed to actually finish the target off
 * is still shown separately below, via the existing "Combo:" row. */
const SHOOTING_QUICK_VIEW_UNIT_GROUPS: string[][] = [
  ["purifier-squad"], // Crowe brick
  ["gmnd-1", "gmnd-2", "gmnd-3"], // GMND
  ["purgation-squad-a"], // Purgation 10
  ["purgation-squad-b"], // Purgation 5
  ["purgation-squad-c"], // Purgation 5 (different loadout)
];

function bestShootingOptionForUnitGroup(
  outcome: BestWayToKillItResult,
  unitIds: string[]
): RankedOption | undefined {
  return outcome.singles
    .filter((o) => unitIds.includes(o.unitId) && o.mode === "shooting")
    .sort(
      (a, b) =>
        b.summary.killProbability - a.summary.killProbability || b.summary.meanDamage - a.summary.meanDamage
    )[0];
}

function pickDisplayOptions(outcome: BestWayToKillItResult): RankedOption[] {
  return SHOOTING_QUICK_VIEW_UNIT_GROUPS.map((ids) => bestShootingOptionForUnitGroup(outcome, ids)).filter(
    (o): o is RankedOption => !!o
  );
}

/** Standalone matched units plus combined attached (Leader+Bodyguard) groups,
 * unified into one list of analysis targets. */
function buildAnalysisTargets(
  listResult: ParseArmyListResult,
  getDisabled: (key: string) => ReadonlySet<string>
): AnalysisTarget[] {
  const targets: AnalysisTarget[] = [];
  for (const unit of listResult.units) {
    if (!unit.datasheet || unit.attachedGroupIndex !== null) continue;
    const key = unitDedupeSignature(unit);
    const source: TargetSource = { kind: "unit", unit };
    const target = parsedUnitToTarget(unit, getDisabled(key));
    if (!target) continue;
    const { detected, unmodeled } = detectForSource(source);
    targets.push({ key, label: unit.rawName, points: unit.points, target, formSeed: unit, source, detected, unmodeled });
  }
  for (const group of listResult.attachedGroups) {
    const key = attachedGroupDedupeSignature(group);
    const source: TargetSource = { kind: "group", group };
    const target = attachedGroupToTarget(group, getDisabled(key));
    if (!target) continue;
    const points = group.members.some((m) => m.points != null)
      ? group.members.reduce((sum, m) => sum + (m.points ?? 0), 0)
      : null;
    const { detected, unmodeled } = detectForSource(source);
    targets.push({ key, label: target.name, points, target, formSeed: null, source, detected, unmodeled });
  }
  return targets;
}

/** Groups identical repeated targets (dedupe key) so an army list with e.g.
 * "4x10 Poxwalkers" as separate entries is analyzed and shown once. Shared
 * between the auto "best way to kill it" pass and the opponent-matchups
 * counters pass, which both need the same target list. */
function groupAnalysisTargets(
  listResult: ParseArmyListResult,
  getDisabled: (key: string) => ReadonlySet<string>
): { entry: AnalysisTarget; multiplicity: number }[] {
  const groups = new Map<string, { entry: AnalysisTarget; multiplicity: number }>();
  for (const entry of buildAnalysisTargets(listResult, getDisabled)) {
    const existing = groups.get(entry.key);
    if (existing) existing.multiplicity += 1;
    else groups.set(entry.key, { entry, multiplicity: 1 });
  }
  return [...groups.values()];
}

/** Short "T4, 3+ sv/5++ inv, 2W ×5" style summary of a target's defensive
 * stats — one line per model-group (an attached Leader+Bodyguard has more
 * than one). */
function formatTargetStatline(target: TargetUnit): string {
  return target.groups
    .map((g) => {
      const save = `${g.save}+ sv`;
      const invuln = g.invulnSave ? `/${g.invulnSave}++ inv` : "";
      const count = g.count > 1 ? ` ×${g.count}` : "";
      return `${g.label}: T${g.toughness}, ${save}${invuln}, ${g.wounds}W${count}`;
    })
    .join(" · ");
}

// Reduced fidelity for the auto/bulk pass across an entire opponent list — the
// manual "Enemy target" form below still runs at full DEFAULT_ITERATIONS for a
// precise look at any one target.
const AUTO_ITERATIONS = 500;
const AUTO_COMBO_ITERATIONS = 400;

const ARCHETYPE_PHRASE: Record<"dreadknight" | "elite" | "light", string> = {
  dreadknight: "anti-Dreadknight (anti-tank)",
  elite: "anti-elite-infantry",
  light: "anti-light-infantry",
};

/** Plain-language summary of what the list, taken as a whole, is built to kill —
 * derived from the points-weighted mix of its units' individual specialties. */
function describeLeaning(v: ThreatVerdict): string {
  const pct = (k: "dreadknight" | "elite" | "light") => (v.weights[k] * 100).toFixed(0);
  const mix = `${pct("dreadknight")}% anti-tank · ${pct("elite")}% anti-elite · ${pct("light")}% anti-light infantry`;
  if (v.leaning === "balanced") {
    return `Taken as a whole, his list is fairly balanced across target types (${mix}).`;
  }
  return `Taken as a whole, his list is weighted toward ${ARCHETYPE_PHRASE[v.leaning]} (${mix}).`;
}

/** Everything needed to restore a working session on next visit: the pasted
 * army list plus every per-opponent toggle set. Results themselves aren't
 * stored — they're re-derived from the list on load, so they always reflect
 * the current roster/engine rather than a stale snapshot. Bump the version
 * suffix if this shape ever changes, so old saved blobs are ignored rather
 * than mis-parsed. */
const SESSION_STORAGE_KEY = "gk-hammer-session-v1";

interface PersistedSession {
  pasteText: string;
  calcSettings: Record<string, DamageSettings>;
  autoCalcSettings: Record<string, DamageSettings>;
  defensiveSettings: Record<string, DefensiveSettings>;
  halfRangeByOpponent: Record<string, boolean>;
  disabledAbilities?: Record<string, string[]>;
}

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null; // private mode, disabled storage, or corrupt data — start fresh
  }
}

function saveSession(session: PersistedSession): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // ignore write failures (private mode / quota) — persistence is best-effort
  }
}

function App() {
  const [form, setForm] = useState<TargetFormState>(DEFAULT_FORM);
  const [results, setResults] = useState<BestWayToKillItResult | null>(null);
  const [resultsLabel, setResultsLabel] = useState<string>("");
  const [resultsTargetWounds, setResultsTargetWounds] = useState<number>(0);
  const [resultsTarget, setResultsTarget] = useState<TargetUnit | null>(null);
  const [sequencingCache, setSequencingCache] = useState<Record<string, SequencingCacheEntry>>({});
  const [sortKey, setSortKey] = useState<SortKey>("kill");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedCombo, setExpandedCombo] = useState<number | null>(null);
  const [expandedAutoKey, setExpandedAutoKey] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  const [pasteText, setPasteText] = useState("");
  const [listResult, setListResult] = useState<ParseArmyListResult | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [autoResults, setAutoResults] = useState<AutoUnitResult[]>([]);
  const [autoAnalyzing, setAutoAnalyzing] = useState(false);
  const [autoProgress, setAutoProgress] = useState({ done: 0, total: 0 });
  const targetFormRef = useRef<HTMLElement | null>(null);
  const resultsAnchorRef = useRef<HTMLDivElement | null>(null);

  const [counterResults, setCounterResults] = useState<CounterUnitResult[]>([]);
  const [counterAnalyzing, setCounterAnalyzing] = useState(false);
  const [counterProgress, setCounterProgress] = useState({ done: 0, total: 0 });

  // Reverse "what threatens me" analysis over the pasted opponent list.
  const [threatResult, setThreatResult] = useState<ThreatAnalysisResult | null>(null);
  const [threatAnalyzing, setThreatAnalyzing] = useState(false);

  // Stratagem/rule toggles for the Opponent matchups cards — keyed per
  // CALCULATION (opponent unit × phase × my unit), not per my-unit alone.
  // The same GMND appearing in the Mutilators card and the Venatari card (or
  // in both the Shooting and Melee sections) are independent entries here,
  // so ticking one never ticks — or visibly changes — any other box.
  const [calcSettings, setCalcSettings] = useState<Record<string, DamageSettings>>({});
  const calcSettingsKey = (opponentKey: string, mode: "shooting" | "melee", unitId: string) =>
    `${opponentKey}::${mode}::${unitId}`;
  const getCalcSettings = (opponentKey: string, mode: "shooting" | "melee", unitId: string): DamageSettings =>
    calcSettings[calcSettingsKey(opponentKey, mode, unitId)] ?? DEFAULT_DAMAGE_SETTINGS;

  // Same idea for the "Best way to kill each unit" cards — keyed per (opponent
  // unit × my unit) only, not per phase: `unitScenarios` builds both the
  // shooting and melee scenario for a unit from one shared settings object,
  // so a single toggle set per my-unit already covers both.
  const [autoCalcSettings, setAutoCalcSettings] = useState<Record<string, DamageSettings>>({});
  const autoCalcSettingsKey = (opponentKey: string, unitId: string) => `${opponentKey}::${unitId}`;
  const getAutoCalcSettings = (opponentKey: string, unitId: string): DamageSettings =>
    autoCalcSettings[autoCalcSettingsKey(opponentKey, unitId)] ?? DEFAULT_DAMAGE_SETTINGS;

  // Defensive toggles (-1 Wound / -1 Damage / -1 AP) — one shared set per
  // OPPONENT UNIT, not per phase or per attacker: these reduce any incoming
  // attack against that unit, so the same toggle applies whether it's shown
  // in the Shooting card or the Melee card for that unit.
  const [defensiveSettings, setDefensiveSettings] = useState<Record<string, DefensiveSettings>>({});
  const getDefensiveSettings = (opponentKey: string): DefensiveSettings =>
    defensiveSettings[opponentKey] ?? DEFAULT_DEFENSIVE_SETTINGS;

  // Manual half-range toggle — one per OPPONENT UNIT (shared between that
  // unit's "Best way to kill" card and its "Opponent matchups — Shooting"
  // card, the same way defensive settings are shared). Default false = full
  // range; true forces the Rapid Fire / Melta half-range band. Only affects
  // shooting calculations.
  const [halfRangeByOpponent, setHalfRangeByOpponent] = useState<Record<string, boolean>>({});
  const getHalfRange = (opponentKey: string): boolean => halfRangeByOpponent[opponentKey] ?? false;

  // Auto-detected opponent defensive abilities are all ON by default; this
  // holds the ability ids the user has switched OFF, per opponent unit.
  const [disabledAbilities, setDisabledAbilities] = useState<Record<string, string[]>>({});
  const getDisabledAbilities = (opponentKey: string): ReadonlySet<string> =>
    new Set(disabledAbilities[opponentKey] ?? []);

  const updateField = <K extends keyof TargetFormState>(key: K, value: TargetFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  /** Toggle one stratagem/rule for exactly one (opponent unit, phase, my
   * unit) calculation. Recomputes only that single row's own numbers in
   * place — same array position, no re-sort — instead of rebuilding or
   * re-ranking the whole results list. Position in the list only ever
   * changes on a fresh "Analyze list" pass, never as a side effect of
   * toggling a stratagem, no matter how the new number compares to the
   * other rows. */
  const updateCalcStratagem = (
    opponentKey: string,
    mode: "shooting" | "melee",
    unitId: string,
    key: keyof DamageSettings,
    value: boolean
  ) => {
    const settingsKey = calcSettingsKey(opponentKey, mode, unitId);
    const nextUnitSettings: DamageSettings = {
      ...(calcSettings[settingsKey] ?? DEFAULT_DAMAGE_SETTINGS),
      [key]: value,
    };
    setCalcSettings((prev) => ({ ...prev, [settingsKey]: nextUnitSettings }));
    const halfRange = getHalfRange(opponentKey);
    setCounterResults((prev) =>
      prev.map((result) => {
        if (result.key !== opponentKey) return result;
        const updatedEntry = computeUnitCounterEntry(
          unitId,
          result.target,
          nextUnitSettings,
          mode,
          mode === "shooting" ? halfRange : undefined
        );
        if (!updatedEntry) return result;
        const list = mode === "shooting" ? result.shooting : result.melee;
        // In-place replace only — no sort — so this row's position (and every
        // other row's position) never moves as a result of this toggle.
        const updated = list.map((e) => (e.unitId === unitId ? updatedEntry : e));
        return mode === "shooting" ? { ...result, shooting: updated } : { ...result, melee: updated };
      })
    );
  };

  /** Toggle one stratagem/rule for one (opponent unit × my unit) pair in the
   * "Best way to kill each unit" cards. Unlike the counter-matchup toggle
   * above, there's no cheap single-row recompute available here — a unit's
   * result competes against the rest of the roster for "top option" and
   * combo-partner status, so the whole target's outcome (every unit, every
   * scenario) is re-run. Still scoped to just this one target's `autoResults`
   * entry, in place — every other target's card is untouched. */
  const updateAutoCalcStratagem = (
    opponentKey: string,
    target: TargetUnit,
    unitId: string,
    key: keyof DamageSettings,
    value: boolean
  ) => {
    const settingsKey = autoCalcSettingsKey(opponentKey, unitId);
    const nextUnitSettings: DamageSettings = {
      ...(autoCalcSettings[settingsKey] ?? DEFAULT_DAMAGE_SETTINGS),
      [key]: value,
    };
    setAutoCalcSettings((prev) => ({ ...prev, [settingsKey]: nextUnitSettings }));
    const targetWithDefenses: TargetUnit = { ...target, defensiveSettings: getDefensiveSettings(opponentKey) };
    const outcome = computeBestWayToKillIt(targetWithDefenses, {
      iterations: AUTO_ITERATIONS,
      comboIterations: AUTO_COMBO_ITERATIONS,
      getUnitSettings: (id) => (id === unitId ? nextUnitSettings : getAutoCalcSettings(opponentKey, id)),
      halfRange: getHalfRange(opponentKey),
    });
    setAutoResults((prev) => prev.map((r) => (r.key === opponentKey ? { ...r, outcome } : r)));
  };

  /** Toggle a defensive rule for one opponent unit. Recomputes every
   * currently-displayed row's own numbers under the new defensive setting —
   * same rows, same order, same array positions — rather than re-running the
   * full roster ranking, which could otherwise swap in a different unit or
   * reorder the list purely because the new numbers compare differently. */
  const updateDefensiveSetting = (opponentKey: string, key: keyof DefensiveSettings, value: boolean) => {
    const nextForOpponent: DefensiveSettings = {
      ...(defensiveSettings[opponentKey] ?? DEFAULT_DEFENSIVE_SETTINGS),
      [key]: value,
    };
    setDefensiveSettings((prev) => ({ ...prev, [opponentKey]: nextForOpponent }));
    const halfRange = getHalfRange(opponentKey);
    setCounterResults((prev) =>
      prev.map((result) => {
        if (result.key !== opponentKey) return result;
        const targetWithDefenses: TargetUnit = { ...result.target, defensiveSettings: nextForOpponent };
        const recompute = (list: CounterRankedUnit[], mode: "shooting" | "melee") =>
          list.map(
            (entry) =>
              computeUnitCounterEntry(
                entry.unitId,
                targetWithDefenses,
                getCalcSettings(opponentKey, mode, entry.unitId),
                mode,
                mode === "shooting" ? halfRange : undefined
              ) ?? entry
          );
        return {
          ...result,
          target: targetWithDefenses,
          shooting: recompute(result.shooting, "shooting"),
          melee: recompute(result.melee, "melee"),
        };
      })
    );
    // The "Best way to kill each unit" cards share the same per-opponent
    // defensive settings, so recompute those too (full re-run, like the
    // stratagem toggle does — a defensive change can shift which of my units
    // ranks best).
    setAutoResults((prev) =>
      prev.map((r) => {
        if (r.key !== opponentKey) return r;
        const targetWithDefenses: TargetUnit = { ...r.target, defensiveSettings: nextForOpponent };
        const outcome = computeBestWayToKillIt(targetWithDefenses, {
          iterations: AUTO_ITERATIONS,
          comboIterations: AUTO_COMBO_ITERATIONS,
          getUnitSettings: (id) => getAutoCalcSettings(opponentKey, id),
          halfRange,
        });
        return { ...r, target: targetWithDefenses, outcome };
      })
    );
  };

  /** Toggle the manual half-range setting for one opponent unit. Recomputes
   * both that opponent's "Best way to kill" card (full re-run) and its
   * "Opponent matchups — Shooting" rows (in place — melee is unaffected by
   * range, so those rows are left untouched). */
  const updateHalfRange = (opponentKey: string, value: boolean) => {
    setHalfRangeByOpponent((prev) => ({ ...prev, [opponentKey]: value }));
    const defense = getDefensiveSettings(opponentKey);
    setAutoResults((prev) =>
      prev.map((r) => {
        if (r.key !== opponentKey) return r;
        const targetWithDefenses: TargetUnit = { ...r.target, defensiveSettings: defense };
        const outcome = computeBestWayToKillIt(targetWithDefenses, {
          iterations: AUTO_ITERATIONS,
          comboIterations: AUTO_COMBO_ITERATIONS,
          getUnitSettings: (id) => getAutoCalcSettings(opponentKey, id),
          halfRange: value,
        });
        return { ...r, outcome };
      })
    );
    setCounterResults((prev) =>
      prev.map((result) => {
        if (result.key !== opponentKey) return result;
        const targetWithDefenses: TargetUnit = { ...result.target, defensiveSettings: defense };
        const shooting = result.shooting.map(
          (entry) =>
            computeUnitCounterEntry(
              entry.unitId,
              targetWithDefenses,
              getCalcSettings(opponentKey, "shooting", entry.unitId),
              "shooting",
              value
            ) ?? entry
        );
        return { ...result, shooting };
      })
    );
  };

  /** Toggle one auto-detected defensive ability on/off for an opponent unit.
   * Rebuilds that unit's target from its parsed source under the new set (which
   * can change model wounds, Feel No Pain, and incoming modifiers) and recomputes
   * both its "Best way to kill" card and its matchup rows. */
  const updateAbility = (opponentKey: string, abilityId: string) => {
    const next = new Set(disabledAbilities[opponentKey] ?? []);
    if (next.has(abilityId)) next.delete(abilityId);
    else next.add(abilityId);
    setDisabledAbilities((prev) => ({ ...prev, [opponentKey]: [...next] }));

    const defense = getDefensiveSettings(opponentKey);
    const halfRange = getHalfRange(opponentKey);

    setAutoResults((prev) =>
      prev.map((r) => {
        if (r.key !== opponentKey) return r;
        const rebuilt = buildTargetFromSource(r.source, next);
        if (!rebuilt) return r;
        const target: TargetUnit = { ...rebuilt, defensiveSettings: defense };
        const outcome = computeBestWayToKillIt(target, {
          iterations: AUTO_ITERATIONS,
          comboIterations: AUTO_COMBO_ITERATIONS,
          getUnitSettings: (id) => getAutoCalcSettings(opponentKey, id),
          halfRange,
        });
        return { ...r, target, outcome };
      })
    );

    setCounterResults((prev) =>
      prev.map((result) => {
        if (result.key !== opponentKey) return result;
        const rebuilt = buildTargetFromSource(result.source, next);
        if (!rebuilt) return result;
        const target: TargetUnit = { ...rebuilt, defensiveSettings: defense };
        const recompute = (list: CounterRankedUnit[], mode: "shooting" | "melee") =>
          list.map(
            (entry) =>
              computeUnitCounterEntry(
                entry.unitId,
                target,
                getCalcSettings(opponentKey, mode, entry.unitId),
                mode,
                mode === "shooting" ? halfRange : undefined
              ) ?? entry
          );
        return { ...result, target, shooting: recompute(result.shooting, "shooting"), melee: recompute(result.melee, "melee") };
      })
    );
  };

  const runAutoAnalysisForList = (result: ParseArmyListResult) => {
    const matched = groupAnalysisTargets(result, getDisabledAbilities);

    setAutoResults([]);
    if (matched.length === 0) {
      setAutoAnalyzing(false);
      return;
    }
    setAutoAnalyzing(true);
    setAutoProgress({ done: 0, total: matched.length });
    let i = 0;
    const step = () => {
      const { entry, multiplicity } = matched[i];
      const target: TargetUnit = { ...entry.target, defensiveSettings: getDefensiveSettings(entry.key) };
      const outcome = computeBestWayToKillIt(target, {
        iterations: AUTO_ITERATIONS,
        comboIterations: AUTO_COMBO_ITERATIONS,
        getUnitSettings: (unitId) => getAutoCalcSettings(entry.key, unitId),
        halfRange: getHalfRange(entry.key),
      });
      setAutoResults((prev) => [
        ...prev,
        {
          key: entry.key,
          label: entry.label,
          target,
          formSeed: entry.formSeed,
          outcome,
          multiplicity,
          source: entry.source,
          detected: entry.detected,
          unmodeled: entry.unmodeled,
        },
      ]);
      i += 1;
      setAutoProgress({ done: i, total: matched.length });
      if (i < matched.length) {
        setTimeout(step, 10); // yield between units so the UI can paint progress
      } else {
        setAutoAnalyzing(false);
      }
    };
    setTimeout(step, 10);
  };

  /** Opponent matchups: for every unit actually in the pasted list, the top 3
   * of my units that counter it best (raw damage, points-efficiency
   * tiebreak) — replaces the old fixed Skirmish/Big Target archetype
   * buckets with real per-opponent-unit matchups. Each row's stratagems
   * default to off until toggled inline on that specific card. */
  const runCounterAnalysisForList = (result: ParseArmyListResult) => {
    const matched = groupAnalysisTargets(result, getDisabledAbilities);

    setCounterResults([]);
    if (matched.length === 0) {
      setCounterAnalyzing(false);
      return;
    }
    setCounterAnalyzing(true);
    setCounterProgress({ done: 0, total: matched.length });
    let i = 0;
    const step = () => {
      const { entry, multiplicity } = matched[i];
      const target: TargetUnit = { ...entry.target, defensiveSettings: getDefensiveSettings(entry.key) };
      const matchups = computeTopCounters(
        target,
        (unitId, mode) => getCalcSettings(entry.key, mode, unitId),
        getHalfRange(entry.key)
      );
      setCounterResults((prev) => [
        ...prev,
        {
          key: entry.key,
          label: entry.label,
          points: entry.points,
          target,
          shooting: matchups.shooting,
          melee: matchups.melee,
          multiplicity,
          source: entry.source,
          detected: entry.detected,
          unmodeled: entry.unmodeled,
        },
      ]);
      i += 1;
      setCounterProgress({ done: i, total: matched.length });
      if (i < matched.length) {
        setTimeout(step, 10);
      } else {
        setCounterAnalyzing(false);
      }
    };
    setTimeout(step, 10);
  };

  /** Reverse analysis: which of the opponent's units most threaten mine, and
   * whether the list leans anti-Dreadknight or anti-infantry. Deferred a tick
   * so the "analyzing…" state can paint before the (synchronous) sim runs. */
  const runThreatAnalysisForList = (result: ParseArmyListResult) => {
    setThreatResult(null);
    setThreatAnalyzing(true);
    setTimeout(() => {
      setThreatResult(computeThreatAnalysis(result));
      setThreatAnalyzing(false);
    }, 10);
  };

  const readList = async (text: string) => {
    if (!text.trim()) return;
    setReading(true);
    setReadError(null);
    setAutoResults([]);
    setCounterResults([]);
    setThreatResult(null);
    try {
      const result = await parseArmyList(text, datasheetProvider);
      // Exclude the faction's shared ability pool from defensive auto-detection
      // before any target is built for analysis.
      setSharedAbilityPool(result.sharedAbilityNames);
      setListResult(result);
      runAutoAnalysisForList(result);
      runCounterAnalysisForList(result);
      runThreatAnalysisForList(result);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
      setListResult(null);
    } finally {
      setReading(false);
    }
  };

  // --- Session persistence (localStorage) ---------------------------------
  // `hydrated` gates saving until AFTER the initial restore has been applied,
  // so the empty first-render state can never clobber a saved session.
  const [hydrated, setHydrated] = useState(false);

  // Restore a saved session once, on first mount.
  useEffect(() => {
    const saved = loadSession();
    if (saved) {
      setPasteText(saved.pasteText ?? "");
      setCalcSettings(saved.calcSettings ?? {});
      setAutoCalcSettings(saved.autoCalcSettings ?? {});
      setDefensiveSettings(saved.defensiveSettings ?? {});
      setHalfRangeByOpponent(saved.halfRangeByOpponent ?? {});
      setDisabledAbilities(saved.disabledAbilities ?? {});
    }
    setHydrated(true);
  }, []);

  // After hydration, re-run the analysis for the restored list so the cards
  // come back populated (results are derived on the fly, not stored). Once.
  const reanalyzedRef = useRef(false);
  useEffect(() => {
    if (!hydrated || reanalyzedRef.current) return;
    reanalyzedRef.current = true;
    if (pasteText.trim()) void readList(pasteText);
  }, [hydrated]);

  // Persist the list + every toggle set whenever they change (post-hydration).
  useEffect(() => {
    if (!hydrated) return;
    saveSession({ pasteText, calcSettings, autoCalcSettings, defensiveSettings, halfRangeByOpponent, disabledAbilities });
  }, [hydrated, pasteText, calcSettings, autoCalcSettings, defensiveSettings, halfRangeByOpponent, disabledAbilities]);

  const handlePasteTextarea = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    setPasteText(text);
    void readList(text);
  };

  const populateFormFromUnit = (unit: ParsedUnit) => {
    const sheet = unit.datasheet;
    if (!sheet) return;
    setForm({
      name: unit.rawName || sheet.name,
      count: unit.modelCount ?? defaultModelCountFromComposition(sheet.composition),
      toughness: sheet.statline.toughness,
      save: sheet.statline.save,
      invulnSave: sheet.statline.invulnSave ?? "",
      wounds: sheet.statline.wounds,
      feelNoPain: "",
      hasCover: false,
      isInfantry: isInfantryDatasheet(unit),
    });
  };

  const useUnitAsTarget = (unit: ParsedUnit) => {
    populateFormFromUnit(unit);
    setResultsLabel(unit.rawName);
    setResults(null);
    targetFormRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
  };

  /** Full-fidelity, full-detail (percentiles, combos, weapon breakdown) analysis for
   * one target from the parsed list (a standalone unit, or a combined attached
   * Leader+Bodyguard group) — the auto pass above trades fidelity for covering
   * every enemy target at once; this re-runs that one target properly. Attached
   * groups have no `formSeed` (they don't fit the manual form's single-group
   * model), so the form is left alone and results are shown under `resultsLabel`
   * instead of the form's name — the manual form below stays whatever it was. */
  const viewFullAnalysis = ({ label, target, formSeed }: { label: string; target: TargetUnit; formSeed: ParsedUnit | null }) => {
    if (formSeed) populateFormFromUnit(formSeed);
    setResultsLabel(label);
    setComputing(true);
    setExpanded(null);
    setExpandedCombo(null);
    // Always scroll to where results/the loading state will render — an
    // attached group has no formSeed, so scrolling only for standalone units
    // (as this used to) left the button appearing to do nothing when clicked
    // for a combined Leader+Bodyguard target.
    resultsAnchorRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
    setTimeout(() => {
      const outcome = computeBestWayToKillIt(target, { getUnitSettings: () => DEFAULT_DAMAGE_SETTINGS });
      setResults({ singles: sortOptions(outcome.singles, sortKey), combinations: outcome.combinations });
      setResultsTargetWounds(targetTotalWounds(target));
      setResultsTarget(target);
      setComputing(false);
    }, 30);
  };

  const runAnalysis = () => {
    setComputing(true);
    setExpanded(null);
    setExpandedCombo(null);
    setResultsLabel(form.name || "Enemy Unit");
    // setTimeout (not requestAnimationFrame, which browsers suspend on a
    // hidden/backgrounded tab) lets the "computing…" state paint before the
    // synchronous, CPU-bound simulation blocks the main thread.
    setTimeout(() => {
      const target = formToTarget(form);
      const outcome = computeBestWayToKillIt(target, { getUnitSettings: () => DEFAULT_DAMAGE_SETTINGS });
      setResults({ singles: sortOptions(outcome.singles, sortKey), combinations: outcome.combinations });
      setResultsTargetWounds(targetTotalWounds(target));
      setResultsTarget(target);
      setComputing(false);
    }, 30);
  };

  const changeSortKey = (key: SortKey) => {
    setSortKey(key);
    if (results) setResults({ ...results, singles: sortOptions(results.singles, key) });
  };

  const bestSingleKill = results?.singles[0]?.summary.killProbability ?? 0;

  const sequencingKey = (opt: RankedOption) => `${opt.unitId}::${opt.mode}::${opt.scenarioLabel}`;

  /** Rebuilds this option's weapon engagements (same unit/scenario the rest
   * of its card already reflects — "Ranked options" always uses baseline,
   * no-stratagem settings) and searches them for the firing order that
   * minimizes overkill. Expensive (permutation search), so this only ever
   * runs when the user explicitly asks for it, not automatically. */
  const computeSequencingFor = (opt: RankedOption) => {
    const target = resultsTarget;
    if (!target) return;
    const key = sequencingKey(opt);
    setSequencingCache((prev) => ({ ...prev, [key]: { loading: true, result: null } }));
    setTimeout(() => {
      const unit = (ROSTER as UnitDefinition[]).find((u) => u.id === opt.unitId);
      const scenario = unit
        ? unitScenarios(unit, DEFAULT_DAMAGE_SETTINGS).find(
            (s) => s.mode === opt.mode && s.label === opt.scenarioLabel
          )
        : undefined;
      const result =
        unit && scenario
          ? computeOptimalSequencing(buildEngagementsForScenario(unit, target, opt.mode, scenario.scenario))
          : null;
      setSequencingCache((prev) => ({ ...prev, [key]: { loading: false, result } }));
    }, 30);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Pure Purge — Best Way to Kill It</h1>
        <p className="subtitle">
          Grey Knights math-hammer, 11th edition · {ARMY_TOTAL_POINTS}pts "Pure Purge"
        </p>
        <p className="credit">
          Rules/points data verified against BSData/wh40k-11e (community-maintained 11e dataset). Not affiliated
          with Games Workshop.
        </p>
      </header>

      <section className="card">
        <h2>Paste opponent's list</h2>
        <p className="section-note">
          Paste a plain-text export from the Warhammer 40,000 app, BattleScribe, or NewRecruit — it analyzes
          automatically the moment you paste. Anything it can't confidently match is flagged below, never guessed.
        </p>
        <textarea
          className="paste-textarea"
          placeholder="Paste your opponent's army list export here…"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          onPaste={handlePasteTextarea}
          rows={6}
        />
        <button
          className="primary-btn"
          onClick={() => readList(pasteText)}
          disabled={reading || !pasteText.trim()}
        >
          {reading ? "Reading list…" : "Analyze list"}
        </button>
        <p className="section-note">Pasting above runs this automatically — only needed if you edit the text.</p>

        {readError && <div className="empty-state">Couldn't read that list: {readError}</div>}
      </section>

      {(threatAnalyzing || threatResult) && (
        <CollapsibleCard
          title="Biggest threats to your army"
          defaultOpen={true}
          badge={threatAnalyzing ? <span className="card-header-badge">analyzing…</span> : undefined}
        >
          <p className="section-note">
            Each unit in the pasted list, evaluated on its own: its best attack (shooting or melee) simulated into a
            representative of each of your unit types — a Dreadknight, elite infantry, and light infantry. Raw weapon
            profiles only (no enemy stratagems, detachment rules, or buffs), so treat these as a floor.
          </p>
          {threatAnalyzing && <div className="loading-state">Assessing threats…</div>}
          {threatResult && (
            <>
              {threatResult.archetypes.length > 0 && (
                <div className="section-note">
                  Reference targets:{" "}
                  {threatResult.archetypes
                    .map((a) => `${a.label} (${a.repName}, ${a.wounds}W${a.models > 1 ? `, ${a.models} models` : ""})`)
                    .join(" · ")}
                </div>
              )}

              <span className="defensive-toggle-label">Top 3 biggest threats</span>
              {threatResult.topThreats.length === 0 ? (
                <div className="empty-state">No evaluable threats found (no matched weapons in the list).</div>
              ) : (
                threatResult.topThreats.map((p, i) => (
                  <div className="auto-option-row" key={i}>
                    <span>
                      {i + 1}. <span className="my-unit-name">{p.attackerName}</span>
                      {p.attackerPoints != null && <span className="section-note"> ({p.attackerPoints}pts)</span>}
                      {p.multiplicity > 1 && <span className="multiplicity-badge">×{p.multiplicity} in list</span>}
                    </span>
                    <span className="threat-figure">
                      clears ~{(p.bestMatchup.fractionDestroyed * 100).toFixed(0)}% of a {p.bestMatchup.label} unit/turn
                    </span>
                  </div>
                ))
              )}

              <div className="threat-verdict">
                <span className="defensive-toggle-label">What his list is built to kill</span>
                <div className="section-note">{describeLeaning(threatResult.verdict)}</div>
              </div>

              {threatResult.profiles.length > 0 && (
                <>
                  <span className="defensive-toggle-label">Per-unit matchups (average damage into each)</span>
                  {threatResult.profiles.map((p, i) => {
                    const specialtyLabel = p.matchups.find((m) => m.key === p.specialty)?.label ?? "—";
                    return (
                      <div className="auto-unit-block" key={i}>
                        <div className="auto-option-row">
                          <span>
                            <span className="my-unit-name">{p.attackerName}</span>
                            {p.attackerPoints != null && <span className="section-note"> ({p.attackerPoints}pts)</span>}
                            {p.multiplicity > 1 && <span className="multiplicity-badge">×{p.multiplicity} in list</span>}
                          </span>
                          <span className="section-note">best at: {specialtyLabel}</span>
                        </div>
                        <div className="section-note">
                          {p.matchups
                            .map((m) => `${m.label}: ${m.meanDamage.toFixed(1)} dmg (${(m.fractionDestroyed * 100).toFixed(0)}%)`)
                            .join(" · ")}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {threatResult.skipped.length > 0 && (
                <div className="section-note">
                  Couldn't evaluate (no matched weapons): {threatResult.skipped.join(", ")}
                </div>
              )}
            </>
          )}
        </CollapsibleCard>
      )}

      {(autoAnalyzing || autoResults.length > 0) && (
        <CollapsibleCard
          title="Best way to kill each unit"
          defaultOpen={true}
          badge={autoAnalyzing ? <span className="card-header-badge">analyzing…</span> : undefined}
        >
          <p className="section-note">
            Quick pass across every matched unit in the list above (lower simulation count for speed — click "Full
            analysis" on any unit for precise numbers, percentiles, and combinations).
          </p>
          {autoAnalyzing && (
            <div className="loading-state">
              Analyzing {autoProgress.done}/{autoProgress.total} units…
            </div>
          )}
          {autoResults.map(({ key: targetKey, label, target, formSeed, outcome, multiplicity, detected, unmodeled }, i) => {
            const top = pickDisplayOptions(outcome);
            const bestKill = top[0]?.summary.killProbability ?? 0;
            const topCombo = bestKill < 0.85 ? outcome.combinations[0] : null;
            return (
              <div className="auto-unit-block" key={i}>
                <div className="auto-unit-header">
                  <span className="option-name">
                    {label}
                    {target.isAttached && <span className="multiplicity-badge">attached</span>}
                    {multiplicity > 1 && <span className="multiplicity-badge">×{multiplicity} in list</span>}
                  </span>
                  <button className="use-target-btn" onClick={() => viewFullAnalysis({ label, target, formSeed })}>
                    Full analysis
                  </button>
                </div>
                <div className="section-note">{formatTargetStatline(target)}</div>
                <DefensiveAbilityToggles
                  detected={detected}
                  unmodeled={unmodeled}
                  disabled={getDisabledAbilities(targetKey)}
                  onToggle={(id) => updateAbility(targetKey, id)}
                />
                <DefensiveToggleRow
                  settings={getDefensiveSettings(targetKey)}
                  onToggle={(key, value) => updateDefensiveSetting(targetKey, key, value)}
                />
                <HalfRangeToggleRow
                  value={getHalfRange(targetKey)}
                  onToggle={(value) => updateHalfRange(targetKey, value)}
                />
                {top.length === 0 && <div className="empty-state">No viable attack options found.</div>}
                {top.map((opt, oi) => {
                  const key = `${i}-${oi}`;
                  const isOpen = expandedAutoKey === key;
                  return (
                    <div key={oi}>
                      <div
                        className="auto-option-row auto-option-clickable"
                        onClick={() => setExpandedAutoKey(isOpen ? null : key)}
                      >
                        <span>
                          <span className="my-unit-name">{opt.unitName}</span>{" "}
                          <span className="section-note">
                            ({opt.mode === "shooting" ? "Shooting" : "Melee"} — {opt.scenarioLabel})
                          </span>
                        </span>
                        <span className={opt.summary.killProbability > 0.5 ? "kill-good" : "kill-bad"}>
                          {(opt.summary.killProbability * 100).toFixed(0)}% kill · {opt.summary.meanDamage.toFixed(1)} dmg ·{" "}
                          {opt.summary.meanModelsKilled.toFixed(2)} models killed
                          {" "}
                          <span className="section-note">
                            ({(opt.summary.meanDamage / Math.max(opt.unitPoints, 1)).toFixed(3)} dmg/pt)
                          </span>
                        </span>
                      </div>
                      {(() => {
                        const unit = (ROSTER as UnitDefinition[]).find((u) => u.id === opt.unitId);
                        return unit ? (
                          <InlineStratagemToggles
                            unit={unit}
                            settings={getAutoCalcSettings(targetKey, unit.id)}
                            onToggle={(sKey, value) => updateAutoCalcStratagem(targetKey, target, unit.id, sKey, value)}
                          />
                        ) : null;
                      })()}
                      {isOpen && (
                        <div className="auto-weapon-breakdown">
                          <FinalDamageBreakdown summary={opt.summary} totalWounds={targetTotalWounds(target)} />
                          <div className="section-note">Each weapon fired alone (won't sum to the total — that accounts for shared overkill):</div>
                          <WeaponBreakdownTable rows={opt.damageByWeapon} />
                        </div>
                      )}
                    </div>
                  );
                })}
                {topCombo &&
                  (() => {
                    const key = `${i}-combo`;
                    const isOpen = expandedAutoKey === key;
                    return (
                      <div>
                        <div
                          className="auto-option-row auto-combo-row auto-option-clickable"
                          onClick={() => setExpandedAutoKey(isOpen ? null : key)}
                        >
                          <span>Combo: {topCombo.unitNames.join(" + ")}</span>
                          <span className={topCombo.summary.killProbability > 0.5 ? "kill-good" : "kill-bad"}>
                            {(topCombo.summary.killProbability * 100).toFixed(0)}% kill ·{" "}
                            {topCombo.summary.meanDamage.toFixed(1)} dmg ·{" "}
                            {topCombo.summary.meanModelsKilled.toFixed(2)} models killed
                          </span>
                        </div>
                        {isOpen && (
                          <div className="auto-weapon-breakdown">
                            <FinalDamageBreakdown summary={topCombo.summary} totalWounds={targetTotalWounds(target)} />
                            <div className="auto-combo-members">
                              {topCombo.memberLabels.map((label, li) => (
                                <div key={li}>
                                  <span>{label}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
              </div>
            );
          })}
        </CollapsibleCard>
      )}

      {(counterAnalyzing || counterResults.length > 0) && (
        <CollapsibleCard
          title="Opponent matchups — Shooting"
          defaultOpen={false}
          badge={counterAnalyzing ? <span className="card-header-badge">analyzing…</span> : undefined}
        >
          <p className="section-note">
            For every unit in the pasted list: my top 3 counters using ranged weapons only, evaluated by each of my
            unit's single best shooting profile against that opponent unit's actual stat line — ranked by raw
            expected damage, with points-per-damage as a tiebreaker (so it doesn't just surface my cheapest unit, or
            let one generalist dominate every matchup). Each row's stratagem/rule toggles apply to that specific
            calculation only.
          </p>
          {counterAnalyzing && (
            <div className="loading-state">
              Evaluating {counterProgress.done}/{counterProgress.total} units…
            </div>
          )}
          {counterResults.map((result) => (
            <CounterUnitBlock
              result={result}
              counters={result.shooting}
              mode="shooting"
              getCalcSettings={getCalcSettings}
              onToggleCalcStratagem={updateCalcStratagem}
              defensiveSettings={getDefensiveSettings(result.key)}
              onToggleDefensive={(key, value) => updateDefensiveSetting(result.key, key, value)}
              halfRange={getHalfRange(result.key)}
              onToggleHalfRange={(value) => updateHalfRange(result.key, value)}
              disabledAbilities={getDisabledAbilities(result.key)}
              onToggleAbility={(id) => updateAbility(result.key, id)}
              key={result.key}
            />
          ))}
        </CollapsibleCard>
      )}

      {(counterAnalyzing || counterResults.length > 0) && (
        <CollapsibleCard
          title="Opponent matchups — Melee"
          defaultOpen={false}
          badge={counterAnalyzing ? <span className="card-header-badge">analyzing…</span> : undefined}
        >
          <p className="section-note">
            Same matchups, evaluated independently using melee weapons only — a unit can rank top 3 in both sections
            if it hits hard both ways, or only show up here if that's where its damage actually comes from. Each
            row's stratagem/rule toggles apply to that specific calculation only.
          </p>
          {counterAnalyzing && (
            <div className="loading-state">
              Evaluating {counterProgress.done}/{counterProgress.total} units…
            </div>
          )}
          {counterResults.map((result) => (
            <CounterUnitBlock
              result={result}
              counters={result.melee}
              mode="melee"
              getCalcSettings={getCalcSettings}
              onToggleCalcStratagem={updateCalcStratagem}
              defensiveSettings={getDefensiveSettings(result.key)}
              onToggleDefensive={(key, value) => updateDefensiveSetting(result.key, key, value)}
              disabledAbilities={getDisabledAbilities(result.key)}
              onToggleAbility={(id) => updateAbility(result.key, id)}
              key={result.key}
            />
          ))}
        </CollapsibleCard>
      )}

      {listResult && (
        <CollapsibleCard title="Parsed units" defaultOpen={false}>
          <div className="parse-result">
            <div className="section-note">
              {listResult.faction ? `Faction: ${listResult.faction}` : "Faction not detected"}
              {listResult.detachment ? ` · Detachment: ${listResult.detachment}` : ""}
              {listResult.totalPoints ? ` · ${listResult.totalPoints}pts` : ""}
            </div>

            {listResult.units.map((unit, i) => (
              <div className="parsed-unit-row" key={i}>
                <div className="parsed-unit-info">
                  <span className={unit.datasheet ? "kill-good" : "kill-bad"}>{unit.datasheet ? "✓" : "?"}</span>
                  <span>
                    {unit.rawName}
                    {unit.modelCount ? ` (${unit.modelCount} models)` : ""}
                    {unit.points ? ` · ${unit.points}pts` : ""}
                    {unit.attachedGroupIndex !== null && (
                      <span className="section-note">
                        {" "}
                        (attached unit {unit.attachedGroupIndex}
                        {unit.attachedRole ? `, ${unit.attachedRole}` : ""} — calculated together above)
                      </span>
                    )}
                  </span>
                </div>
                {unit.datasheet && (
                  <button className="use-target-btn" onClick={() => useUnitAsTarget(unit)}>
                    Use as target
                  </button>
                )}
              </div>
            ))}

            {listResult.unresolved.length > 0 && (
              <div className="unresolved-block">
                <div className="section-note">Couldn't confidently match these lines:</div>
                {listResult.unresolved.map((line, i) => (
                  <div className="unresolved-line" key={i}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleCard>
      )}

      <section className="card" ref={targetFormRef}>
        <h2>Enemy target</h2>
        <div className="form-grid">
          <label className="field span-2">
            Name
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
            />
          </label>
          <label className="field">
            Models
            <input
              type="number"
              min={1}
              value={form.count}
              onChange={(e) => updateField("count", Number(e.target.value))}
            />
          </label>
          <label className="field">
            Toughness
            <input
              type="number"
              min={1}
              value={form.toughness}
              onChange={(e) => updateField("toughness", Number(e.target.value))}
            />
          </label>
          <label className="field">
            Save (e.g. 3 = 3+)
            <input
              type="number"
              min={1}
              max={7}
              value={form.save}
              onChange={(e) => updateField("save", Number(e.target.value))}
            />
          </label>
          <label className="field">
            Invuln save
            <input
              type="number"
              min={2}
              max={6}
              placeholder="none"
              value={form.invulnSave}
              onChange={(e) => updateField("invulnSave", e.target.value === "" ? "" : Number(e.target.value))}
            />
          </label>
          <label className="field">
            Wounds/model
            <input
              type="number"
              min={1}
              value={form.wounds}
              onChange={(e) => updateField("wounds", Number(e.target.value))}
            />
          </label>
          <label className="field">
            Feel No Pain
            <input
              type="number"
              min={2}
              max={6}
              placeholder="none"
              value={form.feelNoPain}
              onChange={(e) => updateField("feelNoPain", e.target.value === "" ? "" : Number(e.target.value))}
            />
          </label>
          <div className="field span-3">
            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={form.hasCover}
                onChange={(e) => updateField("hasCover", e.target.checked)}
              />
              In cover (-1 to hit unless Ignores Cover)
            </div>
            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={form.isInfantry}
                onChange={(e) => updateField("isInfantry", e.target.checked)}
              />
              Has INFANTRY keyword (for Anti-Infantry weapons)
            </div>
          </div>
        </div>
        <button className="primary-btn" onClick={runAnalysis} disabled={computing}>
          {computing ? "Calculating…" : "Find best way to kill it"}
        </button>
      </section>

      <div ref={resultsAnchorRef} />
      {computing && <div className="loading-state">Running Monte Carlo simulations…</div>}

      {!computing && results && (
        <CollapsibleCard title={`Ranked options vs. ${resultsLabel || "Enemy Unit"}`} defaultOpen={true}>
          <div className="sort-row">
            <span>Sort by</span>
            <select value={sortKey} onChange={(e) => changeSortKey(e.target.value as SortKey)}>
              <option value="kill">Kill probability</option>
              <option value="avgDamage">Average damage</option>
              <option value="damagePerPoint">Damage per point cost</option>
            </select>
          </div>
          {results.singles.length === 0 && <div className="empty-state">No viable attack options found.</div>}
          {results.singles.map((opt, i) => (
            <div className="option-card" key={i} onClick={() => setExpanded(expanded === i ? null : i)}>
              <div className="option-top">
                <span className="option-rank">{i + 1}.</span>
                <span className="option-name my-unit-name">{opt.unitName}</span>
                <span className={opt.summary.killProbability > 0.5 ? "kill-good" : "kill-bad"}>
                  {(opt.summary.killProbability * 100).toFixed(0)}% kill
                </span>
              </div>
              <div className="option-scenario">
                {opt.mode === "shooting" ? "Shooting" : "Melee"} — {opt.scenarioLabel} · {opt.unitPoints}pts
              </div>
              <div className="option-stats">
                <div>
                  <span className="stat-value">{opt.summary.meanDamage.toFixed(1)}</span> avg dmg
                </div>
                <div>
                  <span className="stat-value">{opt.summary.meanModelsKilled.toFixed(1)}</span> models killed
                </div>
              </div>
              {expanded === i && (
                <div className="option-detail">
                  <FinalDamageBreakdown summary={opt.summary} totalWounds={resultsTargetWounds} />
                  <div className="detail-grid">
                    <div>
                      <span>Median dmg</span>
                      {opt.summary.medianDamage.toFixed(1)}
                    </div>
                    <div>
                      <span>P10 / P90 dmg</span>
                      {opt.summary.p10.toFixed(1)} / {opt.summary.p90.toFixed(1)}
                    </div>
                    <div>
                      <span>P25 / P75 dmg</span>
                      {opt.summary.p25.toFixed(1)} / {opt.summary.p75.toFixed(1)}
                    </div>
                    <div>
                      <span>Iterations</span>
                      {opt.summary.iterations.toLocaleString()}
                    </div>
                    <div>
                      <span>Wounds remaining</span>
                      {opt.summary.meanWoundsRemaining.toFixed(1)}
                    </div>
                  </div>
                  <div className="section-note">
                    Per weapon, fired alone at a fresh target (won't sum to the total above — that already accounts
                    for shared overkill across all weapons firing together):
                  </div>
                  <WeaponBreakdownTable rows={opt.damageByWeapon} />
                  <SequencingPanel
                    entry={sequencingCache[sequencingKey(opt)]}
                    onCompute={() => computeSequencingFor(opt)}
                  />
                </div>
              )}
            </div>
          ))}
        </CollapsibleCard>
      )}

      {!computing && results && results.combinations.length > 0 && (
        <CollapsibleCard title={`Combine units against ${resultsLabel || "Enemy Unit"}`} defaultOpen={false}>
          <p className="section-note">
            {bestSingleKill >= 0.9
              ? "No single unit above is reliably needed here — shown for reference."
              : "No single unit reliably kills this on its own — here are the smallest/cheapest combinations that do, joint-fire simulated together (shared target, so overkill isn't double-counted)."}
          </p>
          {results.combinations.map((combo, i) => (
            <div
              className="option-card"
              key={i}
              onClick={() => setExpandedCombo(expandedCombo === i ? null : i)}
            >
              <div className="option-top">
                <span className="option-rank">{i + 1}.</span>
                <span className="option-name my-unit-name">{combo.unitNames.join(" + ")}</span>
                <span className={combo.summary.killProbability > 0.5 ? "kill-good" : "kill-bad"}>
                  {(combo.summary.killProbability * 100).toFixed(0)}% kill
                </span>
              </div>
              <div className="option-scenario">
                {combo.unitIds.length} units combined · {combo.totalPoints}pts
              </div>
              <div className="option-stats">
                <div>
                  <span className="stat-value">{combo.summary.meanDamage.toFixed(1)}</span> avg dmg
                </div>
                <div>
                  <span className="stat-value">{combo.summary.meanModelsKilled.toFixed(1)}</span> models killed
                </div>
              </div>
              {expandedCombo === i && (
                <div className="option-detail">
                  <FinalDamageBreakdown summary={combo.summary} totalWounds={resultsTargetWounds} />
                  <div className="weapon-breakdown">
                    {combo.memberLabels.map((label, li) => (
                      <div key={li}>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="detail-grid">
                    <div>
                      <span>Median dmg</span>
                      {combo.summary.medianDamage.toFixed(1)}
                    </div>
                    <div>
                      <span>Wounds remaining</span>
                      {combo.summary.meanWoundsRemaining.toFixed(1)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </CollapsibleCard>
      )}
    </div>
  );
}

export default App;
