/**
 * 11th-edition weapon/attack keyword definitions.
 * Verified verbatim against BSData/wh40k-11e "Warhammer 40,000.json" core rules
 * (live-fetched 2026-08-08). Not sourced from Wahapedia — Wahapedia's public CSV
 * export has not been updated past 10th edition as of this date.
 */

export const KEYWORD_GLOSSARY = {
  SUSTAINED_HITS:
    "Each time an attack made with a [SUSTAINED HITS] weapon results in a critical hit, that attack results in a number of additional hits on the target as denoted by X.",
  LETHAL_HITS:
    "Each time an attack made with a [LETHAL HITS] weapon results in a critical hit, you can choose for that attack to automatically wound the target (no wound roll is made).",
  DEVASTATING_WOUNDS:
    "Each time an attack made with a [DEVASTATING WOUNDS] weapon results in a critical wound, the attack sequence for that attack ends and the target unit suffers a number of mortal wounds equal to the D characteristic of that weapon, inflicted after resolving any normal damage.",
  TWIN_LINKED:
    "Each time an attack is made with a [TWIN-LINKED] weapon, you can re-roll the wound roll.",
  ANTI:
    "This ability always takes the form [ANTI-X Y+]. Each time an attack is made with an [ANTI] weapon, if the target unit has the keyword denoted by X, an unmodified wound roll of Y+ is a critical wound.",
  MELTA:
    "This ability always takes the form [MELTA X]. Each time a model makes an attack with a [MELTA] weapon, if the target unit was within half range of that weapon in the Select Targets step, until the attacking unit's attacks have been resolved, add X to that weapon's D characteristic.",
  RAPID_FIRE:
    "This ability always takes the form [RAPID FIRE X]. Each time you gather attack dice for a [RAPID FIRE] weapon, add X additional attack dice if the target unit was within half range of that weapon in the Select Targets step.",
  BLAST:
    "Each time you gather attack dice for a [BLAST] weapon, add one additional attack die for every five models that were in the target unit in the Select Targets step (rounding down). [BLAST X] adds X additional attack dice per five models instead.",
  TORRENT:
    "Each time an attack is made with a [TORRENT] weapon, that attack automatically hits the target (no hit roll is made).",
  IGNORES_COVER:
    "Each time an attack is made with an [IGNORES COVER] weapon, the target cannot have the benefit of cover against that attack.",
  PRECISION:
    "While resolving attacks made with one or more [PRECISION] weapons, at the start of the Allocation Order step, if the target unit contains one or more CHARACTER models visible to one or more of the attacking models, the active player can select one allocation group that contains one of those CHARACTER models to allocate the attack to, bypassing the normal ordering.",
} as const;

export type KeywordName = keyof typeof KEYWORD_GLOSSARY;
