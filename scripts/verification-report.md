# Grey Knights Army List Verification Report

Source of truth: `Imperium - Grey Knights.json` (BattleScribe/BSData catalogue), 11th edition, fetched from
`https://raw.githubusercontent.com/BSData/wh40k-11e/main/Imperium%20-%20Grey%20Knights.json`.

Verified data written to: `src/army/gk-verified-datasheets.json`

Legend: **MATCH** = claim confirmed exactly against live data. **MISMATCH** = claim differs from live data (details given). **UNRESOLVED** = could not be fully reconciled from static JSON inspection alone (explained below, not guessed).

---

## 1. Castellan Crowe

**Overall: MATCH**, with one naming discrepancy.

| Field | Claimed | Verified | Result |
|---|---|---|---|
| Points | 100 | 100 | MATCH |
| Statline | M6" T4 Sv2+ InvSv4+ W5 Ld6+ OC1 | M6" T4 Sv2+ InvSv4+ W5 Ld6+ OC1 | MATCH |
| Black Blade of Antwyr | A5 WS2+ S6 AP-2 D2, [Devastating Wounds][Precision] | A5 WS2+ S6 AP-2 D2, Devastating Wounds, Precision | MATCH |
| Purifying Flame | 18", A3 BS2+ S4 AP-2 D1, [Anti-Infantry 2+][Ignores Cover][Psychic] | 18", A3 BS2+ S4 AP-2 D1, Anti-Infantry 2+, Ignores Cover, Psychic | MATCH |
| Storm bolter | 24", A2 BS2+ S4 AP0 D1, [Rapid Fire 2] | 24", A2 BS2+ S4 AP0 D1, Rapid Fire 2 | MATCH |
| Ability: Champion of the Order of Purifiers | (name only claimed) | "While this model is leading a unit, add 1 to the Attacks characteristic of Purifying Flame weapons equipped by that unit." | MATCH (name), text now verified |
| Ability: **Foresight** | Claimed name "Foresight" | Verified name is **"Foesight (Psychic)"** — "Each time this model makes an attack that targets a Character unit, you can re-roll the Hit roll." | **MISMATCH (naming only)** — the source data spells it "Foesight", not "Foresight". Mechanic/effect is otherwise as expected for the ability slot. |
| Leader restriction | Can lead/attach to Purifier Squad only | Leader ability text: "This model can be attached to the following unit: ■ Purifier Squad" — no other unit listed | MATCH |

---

## 2. Purifier Squad

**Overall: MATCH.**

| Field | Claimed | Verified | Result |
|---|---|---|---|
| Points (10 models) | 280 | 280 | MATCH — base cost snaps to 260pts at 6+ models, + 4×5pts for Psycannon upgrades = 280 |
| Composition | 1 Knight of the Flame + 9 Purifiers | 1 Knight of the Flame (mandatory) + "4-9 Purifiers" group at 9 selections = 10 models total | MATCH |
| Statline | M6" T4 Sv2+ (no InvSv) W2 Ld6+ OC1 | M6" T4 Sv2+ (InSv field blank) W2 Ld6+ OC1 | MATCH |
| Nemesis force weapon (6 models) | A3 WS3+ S6 AP-2 D2 [Psychic] | A3 WS3+ S6 AP-2 D2, Psychic | MATCH |
| Purifying Flame (unit variant) | A1 BS3+ S4 AP-2 D1 | A1 BS3+ S4 AP-2 D1, Anti-Infantry 2+/Ignores Cover/Psychic | MATCH |
| Storm bolter | (implied standard) | 24" A2 BS3+ S4 AP0 D1, Rapid Fire 2 | MATCH |
| Close combat weapon (4 models) | A3 WS3+ S4 AP0 D1 | A3 WS3+ S4 AP0 D1 | MATCH |
| Psycannon (4 models) | 24" A3 BS3+ S8 AP-1 D2 [Psychic] | 24" A3 BS3+ S8 AP-1 D2, Psychic, +5pts/model | MATCH |
| Ability: Sanctity of Purpose | (name only claimed) | "Each time a model in this unit makes an attack, re-roll a Wound roll of 1. If the target is within range of an objective marker, you can re-roll the Wound roll instead." | MATCH (name), text now verified |

---

## 3. Grand Master in Nemesis Dreadknight (×3)

**Overall: UNRESOLVED on points; MATCH on everything else.**

| Field | Claimed | Verified | Result |
|---|---|---|---|
| Statline | M8" T8 Sv2+ InvSv4+ W13 Ld6+ OC4 | M8" T8 Sv2+ InvSv4+ W13 Ld6+ OC4 | MATCH |
| Fragstorm grenade launcher | 18" AD6 BS3+ S4 AP0 D1 [Blast] | 18" A D6 BS3+ S4 AP0 D1, Blast | MATCH |
| Heavy psycannon | 24" A6 BS3+ S10 AP-2 D3 [Ignores Cover][Psychic] | 24" A6 BS3+ S10 AP-2 D3, Ignores Cover, Psychic, +15pts | MATCH |
| Nemesis daemon greathammer | A5 WS3+ S14 AP-3 D(D6+1) [Psychic] | A5 WS3+ S14 AP-3 D D6+1, Psychic | MATCH |
| Sublimator | 18" A2 BS3+ S9 AP-4 D(D6) [Melta 4][Psychic][Twin-linked] | 18" A2 BS3+ S9 AP-4 D D6, Melta 4, Psychic, Twin-linked, +15pts | MATCH |
| Ability: Surge of Wrath | (name only claimed) | "Each time this model makes a melee attack that targets a Monster or Vehicle unit, you can re-roll the Hit roll, you can re-roll the Wound roll and you can re-roll the Damage roll." | MATCH (name), text verified |
| Ability: Warrior Strategist | (name only claimed) | "Once per battle round, one unit from your army with this ability can use it when its unit is targeted with a Stratagem. If it does, reduce the CP cost of that use of that Stratagem by 1CP." | MATCH (name), text verified |
| **Points** | 255 / 245 / 245 (3 copies) | Base 200 + Heavy psycannon (15) + Sublimator (15) = **230pts** per model from directly-listed costs alone | **UNRESOLVED** |

**Points detail:** None of the three claimed values (255/245/245) equals the straightforward per-model total of 230pts computed from the base cost plus the two paid wargear options. The catalogue does contain a conditional "+15pts for repeat selections of this datasheet" modifier (same mechanism seen on Purifier Squad and Purgation Squad, at different values), which is consistent with 230+15=245 for two of the three claimed costs. The remaining 255 value (230+25) would line up if that particular model is carrying the Tome of Forbidden Ways enhancement (+25pts, confirmed elsewhere in this report) — but which of your three Dreadknights (if any) carries which enhancement, and the exact roster-order trigger condition for the repeat-selection surcharge, cannot be determined from static inspection of the JSON file; it requires replaying BattleScribe's full cost-modifier engine (e.g. via NewRecruit or the BattleScribe app itself) with your actual roster order and enhancement assignments. **Recommend re-verifying these three costs in an actual list-building tool** rather than treating 230/245/245/255 as authoritative from this pass.

---

## 4. Brotherhood Terminator Squad

**Overall: MATCH.**

| Field | Claimed | Verified | Result |
|---|---|---|---|
| Points (4 models) | 140 | 140 | MATCH — base cost for minimum 4-model composition |
| Battleline | Yes | Confirmed: primary categoryLink "Battleline" | MATCH |
| Statline | M5" T5 Sv2+ InvSv4+ W3 Ld6+ OC2 | M5" T5 Sv2+ InvSv4+ W3 Ld6+ OC2 | MATCH |
| Composition | Justicar, 2 Terminator, Ancient | Justicar (mandatory) + Terminator w/ Ancient's Banner + Terminator w/ Narthecium + plain Terminator = 4 models | MATCH |
| Nemesis force weapon (all) | A4 WS3+ S6 AP-2 D2 [Psychic] | A4 WS3+ S6 AP-2 D2, Psychic | MATCH |
| Storm bolter (most) | (standard profile) | 24" A2 BS3+ S4 AP0 D1, Rapid Fire 2 | MATCH |
| Incinerator (Ancient) | 12" AD6 auto-hit S6 AP-1 D1 [Ignores Cover][Torrent] | 12" A D6 BS N/A S6 AP-1 D1, Ignores Cover, Torrent | MATCH |
| Ancient's Banner | (named only) | "Add 1 to the Objective Control characteristic of models in the bearer's unit." | MATCH (name), text verified |
| Apothecary's Narthecium | (named only) | "In your Command phase, if the bearer is not destroyed, you can return 1 destroyed model (excluding Characters) to the bearer's unit." | MATCH (name), text verified |
| Ability: Force Edge | (name only claimed) | "Each time a model in this unit makes a melee attack that targets a unit (excluding Vehicles or Monsters), improve the Armour Penetration characteristic of that attack by 1." | MATCH (name), text verified |

---

## 5. Strike Squad (×2 copies)

**Overall: MATCH.**

| Field | Claimed | Verified | Result |
|---|---|---|---|
| Points (5 models) | 115 each | 115 | MATCH — base cost for minimum 5-model composition (Justicar + 4 Grey Knight) |
| Battleline | Yes | Confirmed: primary categoryLink "Battleline" | MATCH |
| Statline | M6" T4 Sv2+ (no InvSv) W2 Ld6+ OC2 | M6" T4 Sv2+ (InSv blank) W2 Ld6+ OC2 | MATCH |
| Nemesis force weapon + Storm bolter, all 5 models identical | A3 WS3+ S6 AP-2 D2 [Psychic] / 24" A2 BS3+ S4 AP0 D1 [Rapid Fire 2] | Confirmed identical for Justicar and all 4 Grey Knights | MATCH |

Note: the unit also carries a "Sanctifying Ritual (Psychic)" ability not mentioned in the claim — included in the verified JSON for completeness, not a discrepancy since nothing was asserted about it.

---

## 6. Purgation Squad (three separate units, a/b/c)

**Overall: MATCH** on statlines, wargear, and abilities for all three. Points: (a) and (b) MATCH cleanly; (c) MATCHES once a catalogue cost mechanic is accounted for (see below).

Shared statline confirmed for all three: M6" T4 Sv2+ (no InvSv) W2 Ld6+ OC1 — MATCH.
Ability "Righteous Persecution": "In your Shooting phase, after this unit has shot, select one enemy unit (excluding Monsters or Vehicles) hit by one or more of those attacks; until the start of your next turn, that enemy unit is pinned. While a unit is pinned, subtract 2 from that unit's Move characteristic and subtract 2 from Charge rolls made for it." — MATCH (name claimed, text now verified).

Weapon profiles confirmed for all three: Nemesis force weapon (A3 WS3+ S6 AP-2 D2, Psychic), Storm bolter (24" A2 BS3+ S4 AP0 D1, Rapid Fire 2), Close combat weapon (A3 WS3+ S4 AP0 D1), Psycannon (24" A3 BS3+ S8 AP-1 D2, Psychic, +5pts/model), Psilencer (24" A6 BS3+ S5 AP0 D1, Precision/Psychic/Sustained Hits 1, +0pts/model) — all MATCH.

| Variant | Claimed pts | Verified pts | Breakdown | Result |
|---|---|---|---|---|
| (a) 240pts, 10 models | 240 | 240 | Base snaps to 220pts at 6+ models, + 4×5pts Psycannon = 240 | MATCH |
| (b) 130pts, 5 models | 130 | 130 | Base 110pts (5-model minimum) + 4×5pts Psycannon = 130 | MATCH |
| (c) 135pts, 5 models | 135 | 135 (see note) | Base 110pts + 1×0pts Psilencer + 3×5pts Psycannon = 125pts from item costs alone. The catalogue also has a conditional +10pts "repeat selection" surcharge for additional copies of the Purgation Squad datasheet in the same roster; 125+10 = 135pts, consistent with this being the 3rd Purgation Squad in the list. | MATCH, but the extra 10pts depends on this being the 3rd copy taken (list order), not a flat per-model cost — flagged for transparency. |

Boons of Deimos enhancement (on variant a): confirmed as a separate 20pt cost from the "Enhancements" pool, not folded into the 240pt unit cost — consistent with the claim structure.

---

## Detachment Abilities

| Ability | Detachment | Claimed | Verified | Result |
|---|---|---|---|---|
| Fury of Titan | Brotherhood Strike | "Each time a unit from your army is set up using the Deep Strike rule, until the end of the turn, each time a model in that unit makes an attack, re-roll a Hit roll of 1 and re-roll a Wound roll of 1." | Identical text found (id `5845-81f6-ba0d-3357`) | **EXACT MATCH** |
| Searing Soulflame | Fires of Purgation | (presence only previously confirmed) | "When you select a unit to be pinned by a friendly PURGATION SQUAD unit's Righteous Persecution ability, that enemy unit makes a battle-shock roll, with -1 to that battle-shock roll." (id `5ed8-b76b-eadc-a7a8`) | MATCH (full text now captured) |

Both detachment abilities are passive/always-on rules with no CP cost (they are not Stratagems).

---

## Enhancements

| Enhancement | Detachment | Claimed pts | Verified pts | Verified text | Result |
|---|---|---|---|---|---|
| Purity of Purpose | Brotherhood Strike | 15 | 15 | "Grey Knights model only. Each time the bearer's unit is set up using the Deep Strike ability, until the end of the turn, you can re-roll Charge rolls made for the bearer's unit." | MATCH |
| Tome of Forbidden Ways | Brotherhood Strike | 25 | 25 | "Grey Knights model only. While the bearer is on the battlefield or in Strategic Reserves, add 1 to the number of units from your army that you can select for the Gate of Infinity rule." | MATCH |
| Boons of Deimos | Fires of Purgation | 20, "+2 S to this unit's ranged attacks" | 20 | "PURGATION SQUAD unit only. This unit's ranged attacks have +2 S." | MATCH |

---

## Stratagem Text Absence Check

Searched the full raw catalogue text for: Truesilver Channelling, Purgation Pattern, Focused Immolation, Spiritsear, Soul-Locked, Command Re-roll.

**Result: 0 matches for any of these names.** The word "Stratagem" appears only 11 times total, always inside generic ability text (e.g. Warrior Strategist referencing "targeted with a Stratagem"), never as an actual stratagem card definition.

**Conclusion: CONFIRMED** — this BSData catalogue does not include stratagem card text, as expected. It only contains list-building data (points, wargear, abilities, enhancements, detachment rules).

---

## Summary

- **Units/rules checked:** 6 unit datasheets (11 total list entries counting the Grand Master ×3, Strike Squad ×2, Purgation Squad ×3 variants), 2 detachment abilities, 3 enhancements, 1 leader-attachment rule, stratagem-absence check.
- **Clean exact matches:** Castellan Crowe (except one ability-name spelling), Purifier Squad, Brotherhood Terminator Squad, both Strike Squads, Purgation Squad (a) and (b), both detachment abilities (verbatim), all three enhancements (points and text).
- **Naming discrepancy (not mechanical):** Crowe's "Foresight" ability is actually named "Foesight" in the source data.
- **Points discrepancy resolved via catalogue mechanics:** Purgation Squad (c) 135pts checks out once a "3rd copy of this datasheet" +10pts surcharge in the catalogue is applied.
- **Unresolved:** Grand Master in Nemesis Dreadknight's claimed per-copy costs (255/245/245) could not be cleanly reproduced from the catalogue's directly-listed costs (230pts base+wargear) plus its repeat-copy surcharge and/or enhancement costs, without knowing the exact roster order and which model(s) carry which enhancement. All wargear/statline/ability data for the Dreadknight is otherwise fully verified and correct. Recommend confirming the three Dreadknight point totals in a full list-building tool.
