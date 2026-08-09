import { useRef, useState } from "react";
import "./App.css";
import type { TargetUnit } from "./engine/types";
import {
  computeBestWayToKillIt,
  sortOptions,
  type BestWayToKillItResult,
  type SortKey,
} from "./army/bestWayToKillIt";
import { ARMY_TOTAL_POINTS } from "./army/roster";
import { parseArmyList, type ParseArmyListResult, type ParsedUnit } from "./parser/parseArmyList";
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

function parsedUnitToTarget(unit: ParsedUnit): TargetUnit | null {
  const sheet = unit.datasheet;
  if (!sheet) return null;
  const name = unit.rawName || sheet.name;
  const count = unit.modelCount ?? 5;
  return {
    name,
    isAttached: false,
    hasCover: false,
    modelCountForBlast: count,
    groups: [
      {
        label: name,
        count,
        toughness: sheet.statline.toughness,
        save: sheet.statline.save,
        invulnSave: sheet.statline.invulnSave,
        wounds: sheet.statline.wounds,
      },
    ],
  };
}

function isInfantryDatasheet(unit: ParsedUnit): boolean {
  return !!unit.datasheet?.keywords.some((k) => k.toUpperCase() === "INFANTRY");
}

interface AutoUnitResult {
  unit: ParsedUnit;
  outcome: BestWayToKillItResult;
}

// Reduced fidelity for the auto/bulk pass across an entire opponent list — the
// manual "Enemy target" form below still runs at full DEFAULT_ITERATIONS for a
// precise look at any one target.
const AUTO_ITERATIONS = 500;
const AUTO_COMBO_ITERATIONS = 400;

function App() {
  const [form, setForm] = useState<TargetFormState>(DEFAULT_FORM);
  const [results, setResults] = useState<BestWayToKillItResult | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("kill");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedCombo, setExpandedCombo] = useState<number | null>(null);
  const [computing, setComputing] = useState(false);

  const [pasteText, setPasteText] = useState("");
  const [listResult, setListResult] = useState<ParseArmyListResult | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [autoResults, setAutoResults] = useState<AutoUnitResult[]>([]);
  const [autoAnalyzing, setAutoAnalyzing] = useState(false);
  const [autoProgress, setAutoProgress] = useState({ done: 0, total: 0 });
  const targetFormRef = useRef<HTMLElement | null>(null);

  const updateField = <K extends keyof TargetFormState>(key: K, value: TargetFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const runAutoAnalysisForList = (result: ParseArmyListResult) => {
    const matched = result.units.filter((u) => u.datasheet);
    setAutoResults([]);
    if (matched.length === 0) {
      setAutoAnalyzing(false);
      return;
    }
    setAutoAnalyzing(true);
    setAutoProgress({ done: 0, total: matched.length });
    let i = 0;
    const step = () => {
      const unit = matched[i];
      const target = parsedUnitToTarget(unit);
      if (target) {
        const outcome = computeBestWayToKillIt(target, {
          iterations: AUTO_ITERATIONS,
          comboIterations: AUTO_COMBO_ITERATIONS,
        });
        setAutoResults((prev) => [...prev, { unit, outcome }]);
      }
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

  const readList = async (text: string) => {
    if (!text.trim()) return;
    setReading(true);
    setReadError(null);
    setAutoResults([]);
    try {
      const result = await parseArmyList(text, datasheetProvider);
      setListResult(result);
      runAutoAnalysisForList(result);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
      setListResult(null);
    } finally {
      setReading(false);
    }
  };

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
      count: unit.modelCount ?? 5,
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
    setResults(null);
    targetFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /** Full-fidelity, full-detail (percentiles, combos, weapon breakdown) analysis for
   * one unit from the parsed list — the auto pass above trades fidelity for covering
   * every enemy unit at once; this re-runs that one target properly. */
  const viewFullAnalysis = (unit: ParsedUnit) => {
    populateFormFromUnit(unit);
    const target = parsedUnitToTarget(unit);
    if (!target) return;
    setComputing(true);
    setExpanded(null);
    setExpandedCombo(null);
    targetFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      const outcome = computeBestWayToKillIt(target);
      setResults({ singles: sortOptions(outcome.singles, sortKey), combinations: outcome.combinations });
      setComputing(false);
    }, 30);
  };

  const runAnalysis = () => {
    setComputing(true);
    setExpanded(null);
    setExpandedCombo(null);
    // setTimeout (not requestAnimationFrame, which browsers suspend on a
    // hidden/backgrounded tab) lets the "computing…" state paint before the
    // synchronous, CPU-bound simulation blocks the main thread.
    setTimeout(() => {
      const target = formToTarget(form);
      const outcome = computeBestWayToKillIt(target);
      setResults({ singles: sortOptions(outcome.singles, sortKey), combinations: outcome.combinations });
      setComputing(false);
    }, 30);
  };

  const changeSortKey = (key: SortKey) => {
    setSortKey(key);
    if (results) setResults({ ...results, singles: sortOptions(results.singles, key) });
  };

  const bestSingleKill = results?.singles[0]?.summary.killProbability ?? 0;

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

        {listResult && (
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
        )}
      </section>

      {(autoAnalyzing || autoResults.length > 0) && (
        <section className="card">
          <h2>Best way to kill each unit</h2>
          <p className="section-note">
            Quick pass across every matched unit in the list above (lower simulation count for speed — click "Full
            analysis" on any unit for precise numbers, percentiles, and combinations).
          </p>
          {autoAnalyzing && (
            <div className="loading-state">
              Analyzing {autoProgress.done}/{autoProgress.total} units…
            </div>
          )}
          {autoResults.map(({ unit, outcome }, i) => {
            const top = outcome.singles.slice(0, 2);
            const bestKill = top[0]?.summary.killProbability ?? 0;
            const topCombo = bestKill < 0.85 ? outcome.combinations[0] : null;
            return (
              <div className="auto-unit-block" key={i}>
                <div className="auto-unit-header">
                  <span className="option-name">{unit.rawName}</span>
                  <button className="use-target-btn" onClick={() => viewFullAnalysis(unit)}>
                    Full analysis
                  </button>
                </div>
                {top.length === 0 && <div className="empty-state">No viable attack options found.</div>}
                {top.map((opt, oi) => (
                  <div className="auto-option-row" key={oi}>
                    <span>
                      {opt.unitName} <span className="section-note">({opt.mode === "shooting" ? "Shooting" : "Melee"} — {opt.scenarioLabel})</span>
                    </span>
                    <span className={opt.summary.killProbability > 0.5 ? "kill-good" : "kill-bad"}>
                      {(opt.summary.killProbability * 100).toFixed(0)}% kill · {opt.summary.meanDamage.toFixed(1)} dmg
                    </span>
                  </div>
                ))}
                {topCombo && (
                  <div className="auto-option-row auto-combo-row">
                    <span>Combo: {topCombo.unitNames.join(" + ")}</span>
                    <span className={topCombo.summary.killProbability > 0.5 ? "kill-good" : "kill-bad"}>
                      {(topCombo.summary.killProbability * 100).toFixed(0)}% kill · {topCombo.summary.meanDamage.toFixed(1)} dmg
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </section>
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

      {computing && <div className="loading-state">Running Monte Carlo simulations…</div>}

      {!computing && results && (
        <section className="card">
          <h2>Ranked options vs. {form.name || "Enemy Unit"}</h2>
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
                <span className="option-name">{opt.unitName}</span>
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
                  <div className="detail-grid">
                    <div>
                      <span>Median dmg</span>
                      {opt.summary.medianDamage.toFixed(1)}
                    </div>
                    <div>
                      <span>Std dev</span>
                      {opt.summary.stdDevDamage.toFixed(1)}
                    </div>
                    <div>
                      <span>Wipe %</span>
                      {(opt.summary.wipeProbability * 100).toFixed(0)}%
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
                  <div className="weapon-breakdown">
                    {opt.damageByWeapon.map((w, wi) => (
                      <div key={wi}>
                        <span>{w.label}</span>
                        <span>{w.avg.toFixed(2)} dmg</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {!computing && results && results.combinations.length > 0 && (
        <section className="card">
          <h2>Combine units against {form.name || "Enemy Unit"}</h2>
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
                <span className="option-name">{combo.unitNames.join(" + ")}</span>
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
                      <span>Wipe %</span>
                      {(combo.summary.wipeProbability * 100).toFixed(0)}%
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
        </section>
      )}
    </div>
  );
}

export default App;
