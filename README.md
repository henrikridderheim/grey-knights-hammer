# Grey Knights 11e "Best Way to Kill It" Engine

A math-hammer web app built around one specific Grey Knights army ("Pure Purge", 2000pts,
Brotherhood Strike + Fires of Purgation). Paste an opponent's list, and for every enemy unit
it ranks the best ways your army can kill it — Monte Carlo simulated, not expected-value shortcuts.

## Status

- ✅ Monte Carlo attack-sequence engine (hit/wound/save/damage, all listed 11e keywords), unit-tested
  against hand-calculated probabilities.
- ✅ Your army roster, weapons, stratagems, detachment rules and enhancements, cross-checked
  against live 11e data — see `scripts/verification-report.md`.
- ✅ "Best way to kill it" ranked finder, working end-to-end against a manually-entered target.
- 🚧 Opponent army list paste-in parser + multi-faction datasheet database (in progress).
- ⏳ Full matchup matrix view, manual multi-unit combination calculator.
- ⏳ Deployed URL (see below for how to deploy your own copy).

## Data sources & provenance

- **Not Wahapedia.** Wahapedia's public CSV export (`wahapedia.ru/wh40k11ed/...`) is still
  mirroring 10th-edition data as of this build — confirmed by direct comparison, so it wasn't
  usable here.
- **BSData/wh40k-11e** (`github.com/BSData/wh40k-11e`) is the live data source used instead —
  a community-maintained but currently-accurate 11th-edition dataset. Several claims from the
  original army spec were independently cross-checked against it and matched verbatim
  (detachment rules, enhancements, full weapon/unit statlines).
- **Stratagem card text** (Truesilver Channelling, Purgation Pattern, Focused Immolation,
  Spiritsear, Soul-Locked) is **not** in BattleScribe/BSData data — that data format only
  covers list-building, not in-game stratagems. Truesilver Channelling and Purgation Pattern
  were separately confirmed against a Wahapedia 10e mirror of the same (unchanged) Brotherhood
  Strike detachment. Focused Immolation, Spiritsear, and Soul-Locked (Fires of Purgation) could
  not be verified against any live source and are taken as given from the original spec —
  worth double-checking against the physical/app rules if exact wording ever matters.
- **Open item:** the three Grand Master in Nemesis Dreadknight point costs (255/245/245) don't
  cleanly reproduce from the catalogue's base+wargear costs without knowing exact roster order
  and enhancement assignment. Doesn't affect the damage math, only the points display.

Full reconciliation: [`scripts/verification-report.md`](scripts/verification-report.md).

## Running locally

```bash
npm install
npm run dev
```

Then open the printed local URL (defaults to http://localhost:5173).

## Testing

```bash
npx vitest run
```

## Deploying

This is a static site (no backend). `npm run build` outputs to `dist/`.

**GitHub Pages** (workflow already included at `.github/workflows/deploy.yml`):
1. Push this repo to GitHub.
2. In the repo's Settings → Pages, set Source to "GitHub Actions".
3. Push to `main` — the workflow builds and deploys automatically.

**Netlify / Vercel / Cloudflare Pages**: connect the repo, build command `npm run build`,
publish directory `dist` — all three auto-detect Vite and need no extra config.

## Re-syncing data

`npm run sync-data` (see `scripts/PIPELINE_NOTES.md` once the data pipeline lands) re-fetches
and re-parses the BSData catalogues. Your own army list lives in `src/army/roster.ts` — hand-edit
it directly when your list changes.

---

Not affiliated with Games Workshop. Rules/points data credit: [BSData](https://github.com/BSData).
