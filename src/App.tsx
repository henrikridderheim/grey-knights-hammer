import { useState } from "react";
import "./App.css";
import type { TargetUnit } from "./engine/types";
import { computeBestWayToKillIt, sortOptions, type RankedOption, type SortKey } from "./army/bestWayToKillIt";
import { ARMY_TOTAL_POINTS } from "./army/roster";

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

function App() {
  const [form, setForm] = useState<TargetFormState>(DEFAULT_FORM);
  const [results, setResults] = useState<RankedOption[] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("kill");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [computing, setComputing] = useState(false);

  const updateField = <K extends keyof TargetFormState>(key: K, value: TargetFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const runAnalysis = () => {
    setComputing(true);
    setExpanded(null);
    // setTimeout (not requestAnimationFrame, which browsers suspend on a
    // hidden/backgrounded tab) lets the "computing…" state paint before the
    // synchronous, CPU-bound simulation blocks the main thread.
    setTimeout(() => {
      const target = formToTarget(form);
      const options = computeBestWayToKillIt(target);
      setResults(sortOptions(options, sortKey));
      setComputing(false);
    }, 30);
  };

  const changeSortKey = (key: SortKey) => {
    setSortKey(key);
    if (results) setResults(sortOptions(results, key));
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
          {results.length === 0 && <div className="empty-state">No viable attack options found.</div>}
          {results.map((opt, i) => (
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
    </div>
  );
}

export default App;
