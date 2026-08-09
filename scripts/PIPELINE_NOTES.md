# Data pipeline & parser — shortcuts and judgment calls

Honest record of where `scripts/fetch-and-parse-data.mjs` and
`src/parser/parseArmyList.ts` cut scope, approximated, or made a call that a
future pass might want to revisit. Nothing here is hidden in the code without
a comment — this file is just the consolidated view.

## Data pipeline (`scripts/fetch-and-parse-data.mjs`)

**Points are base datasheet cost only.** `costs[].value` ("pts") on the
top-level unit entry, nothing else. Wargear upcharges, repeat-copy surcharges,
and model-count cost tiers are **not** added in. BSData's own cost-modifier
system is genuinely complex (see `scripts/verification-report.md`'s Grand
Master in Nemesis Dreadknight case for a worked example of how hard this gets
even by hand) and the task brief explicitly deprioritizes points accuracy vs.
combat stats. Treat `points` in the output JSON as "roughly what a bare-bones
copy costs," not as list-legal.

**Weapons are a pooled superset of every option, not "the default loadout."**
Rather than trying to reconstruct BattleScribe's default wargear selection, a
unit's `weapons` array is every `Ranged Weapons`/`Melee Weapons` profile
reachable anywhere in its selection tree (including every alternative in every
wargear-choice group), deduplicated by name+stats. This was a deliberate
change from the brief's suggested "extract the default loadout" MVP shape —
reasoning: the parser's job is to match an *opponent's actual stated wargear*
against a datasheet, and a real opponent's list will often not be the
"default" loadout at all. A superset that the parser can match real wargear
lines against is strictly more useful here than a single guessed default,
without materially more implementation cost.

**Composition is a heuristic model-count range, not full composition text.**
`guessComposition()` reads the min/max "selections" constraint off the first
selectionEntryGroup that looks like a per-model choice group, and renders it
as `"10-20 models"` / `"1 model"` / etc. It does not attempt to reconstruct
compound text like "1 Sergeant + 4-9 Marines" the way the hand-verified
`src/army/gk-verified-datasheets.json` does. Good enough to sanity-check a
parsed unit's model count against; not meant to be quoted as authoritative
composition text.

**Multi-die Attacks/Damage values are approximated as a flat mean.** The
engine's `DiceSpec` type (`number | {dice: "D3"|"D6", flat?: number}`) has no
field for a dice *count* multiplier, so source values like `"2D6"` or `"3D6+2"`
(mostly big blast/heavy weapons) can't be represented exactly. These are
converted to a rounded flat number using the die's mean (D3→2, D6→3.5) —
e.g. `"2D6"` → `7`. This preserves expected/average damage (the thing a
mathhammer tool cares about most) at the cost of that weapon's damage
variance. 284 weapons hit this path across all factions in the run this
pipeline produced; each one logs a `[warn]` naming the exact spec approximated.

**`Sustained Hits DX` (non-numeric X) is stored as a string.** A small number
of weapons (47 in the current run) have `Sustained Hits D3` instead of a flat
number. The engine's `WeaponKeywords.sustainedHits` field is typed `number`,
but this pipeline's output is plain JSON, not compiled against that type — the
value is stored as the string `"D3"` and flagged as a `NormalizedWeaponKeywords`
type that explicitly allows `number | string` for this one field (see
`src/parser/types.ts`). A consumer that wants a single number will need to
pick a convention (e.g. treat "D3" as its mean, 2) before feeding it to the
simulation engine.

**Unmodeled weapon keywords are preserved in `rawKeywords`, dropped from the
structured `keywords`.** Heavy, Assault, Pistol, Hazardous, Indirect Fire, One
Shot, Lance, etc. have no field in `src/engine/types.ts`'s `WeaponKeywords`
(the engine's damage-math scope doesn't cover them), so they're kept verbatim
in each weapon's `rawKeywords: string[]` for reference/display, but don't
affect `keywords`.

**Loyalist Space Marine chapters get the base Space Marines roster merged in;
nothing else does.** Chapter catalogues (Ultramarines, Blood Angels, Iron
Hands, ...) only contain their own chapter-specific characters/relics and
import the ~130-unit base "Imperium - Space Marines" catalogue via
`catalogueLinks[].importRootEntries`. This pipeline special-cases exactly that
one link (`AUTO_MERGE_BASE_CATALOGUE` in the script) and merges the base
roster's units into each chapter's output file (chapter-specific units with
the same name win). Other `importRootEntries: true` links on the same
factions — "Imperium - Imperial Knights - Library", "Imperium - Agents of the
Imperium" — are deliberately **not** auto-merged the same way, since that
would pull allied-detachment options far beyond the chapter's own datasheets
into every single Imperium faction file. This is a scope call, not a
technical limitation; broadening it would be a small, well-contained change if
wanted later.

**A related but different fix: "thin wrapper + Library" factions.** Astra
Militarum, Craftworlds, Drukhari, Chaos Daemons, Chaos Knights, and Imperial
Knights are structured differently — their own catalogue file has an
(near-)empty `sharedSelectionEntries` and its ~140 `entryLinks` point directly
at ids that only exist in a separate linked "Library" catalogue file
(regardless of that link's `importRootEntries` flag, which turned out to only
govern BattleScribe's own UI auto-population, not id resolvability — a
surprising real inconsistency in the source data). The fix here is different
from the chapter-merge case above: rather than merging in another catalogue's
*root unit list*, the id/rule/profile lookup indexes are unioned across every
linked catalogue so the wrapper's *own* entryLinks resolve correctly. No extra
root units are added beyond what the wrapper itself lists, so this doesn't
carry the same bloat risk as the chapter case.

**Coverage: 42 of 46 fetched faction files produced usable output.** The 4
that produced zero units are pure shared-data "Library" catalogues that exist
only to be linked into other files and have no root `entryLinks` of their own
(`Aeldari - Aeldari Library`, `Library - Astartes Heresy Legends`, `Library -
Tyranids`) plus the core `Warhammer 40,000.json` system file, which is
intentionally skipped (its keyword glossary is already hand-verified into
`src/engine/keywords.ts`). All factions named in the task brief as priorities
— Space Marines and its chapters, Necrons, Tyranids, Orks, Chaos Space
Marines, T'au Empire, Aeldari/Craftworlds, Astra Militarum, Adeptus Custodes —
have real unit counts in the 30–200 range. Run `npm run sync-data` and check
`public/data/index.json` for exact current counts (numbers will drift as
BSData is updated upstream).

**`[Legends]` units are included, not filtered out.** They're kept (with the
`[Legends]` suffix still in the name, and a `legends: true` flag) rather than
dropped, on the theory that an opponent might still field one and the parser
should be able to match it rather than flag it unresolved. No attempt is made
to otherwise distinguish current vs. Legends rules validity.

**~558 warnings in a full run, overwhelmingly the two categories above** (dice
approximation + non-numeric sustained hits). The pipeline logs every one
individually and never crashes on a single bad unit/weapon/faction — a failure
is caught, warned, and skipped at the narrowest scope possible (weapon → unit
→ faction file), so one bad datasheet never takes down the whole run.

## Army list parser (`src/parser/parseArmyList.ts`)

**Line-heuristic, not a grammar for one exact format.** No real sample army
list exports were available while building this — the three synthetic
fixtures in `parseArmyList.test.ts` (BattleScribe "Full" text export,
NewRecruit text export, WH40k app export) are hand-built from general
knowledge of each tool's typical output, not captured from real exports. The
parser classifies lines structurally (indentation relative to the enclosing
unit line, bullet-vs-no-bullet, "+...+" decoration, known section-header
words, "Key: Value" metadata lines) rather than hard-coding positions, so it
should tolerate reasonable format drift — but it has not been validated
against a real export, and probably needs adjustment once one is available.

**Preamble suppression is a deliberate approximation.** Once a faction is
resolved, an unmatched top-level-looking line is only added to `unresolved`
after the *first* successful unit match — before that, it's treated as
leftover roster-title/header text (list name, points-limit summary, a bare
detachment-name line printed without a label) and silently skipped. This
avoids false-positive "unresolved unit" noise from lines like `"Necrons
Battle Force (255 points)"`, at the cost of theoretically swallowing a real
first unit that happens to appear before any header and fails to match (e.g.
due to a typo in the very first entry). If no faction could be resolved at
all, this suppression does **not** apply — every unmatched line is surfaced
immediately, since there's no basis for guessing what's preamble.

**Detachment detection has no ground truth to match against.** Unlike units,
this pipeline doesn't have a structured list of valid detachment names to
check against (BSData encodes detachments as selectable options within the
catalogue's own detachment-rule entries, which weren't extracted here — see
"What to build" §1's scope). So detachment detection is purely textual: an
explicit `"Detachment: X"` label if present, else the first plausible
standalone header-zone line that isn't the faction name, a section header, or
a points total. This is inherently the weakest-confidence field in the
output — treat `detachment` as a best-effort display hint, not something to
gate logic on.

**Unit-name matching is exact (post-normalization), never fuzzy.** Matching
lowercases, collapses whitespace, and strips a trailing "(N pts)" suffix, but
never does edit-distance/substring fuzzy matching against unit names — per
the task brief's explicit constraint, a near-miss is surfaced as `unresolved`
rather than silently matched to a similar-sounding real unit. The one place
"fuzzy" logic exists at all is faction *detection*, where — only if no
explicit faction declaration is found anywhere in the header — every known
faction's unit index is scored against the document's candidate unit-name
lines and the clear top scorer (if any) is used; an explicit but unrecognized
`"Faction: X"` declaration is always honored as-is (never silently overridden
by this fallback) per the same never-guess principle.

**Wargear matching is per-unit, not globally cross-checked.** A wargear
sub-line is matched only against the weapons list of whichever unit block it's
currently nested under. If it doesn't match (typo, a weapon this pipeline
failed to parse, genuinely homebrew wargear), it's kept in that unit's
`wargear` array with `matchedWeaponName: null` rather than being dropped or
added to the top-level `unresolved` list — `unresolved` is reserved for
lines that couldn't be matched to a *unit*, per the task brief's type
contract. A caller that wants to know about individually-unresolved wargear
lines should scan `units[].wargear` for `matchedWeaponName === null`.

**The first unmatched-as-weapon sub-line with a count multiplier is assumed to
be the unit's own "Nx Model Name" composition line** (e.g. "10x Necron
Warrior" under "Necron Warriors") and is captured as `modelCount` rather than
pushed into `wargear`. Every subsequent unmatched line, even with a count
multiplier, is treated as an ordinary (unresolved) wargear entry — this
avoids one unit's composition line being confused with a similarly-shaped
wargear line further down, at the cost of only ever catching the composition
line if it's genuinely first.
