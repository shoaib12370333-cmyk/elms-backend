/**
 * A seller's own list, built-in starting point - services/prohibitedItemsService.js flags a draft or live listing
 * whose title/description/bullet points/specifications contain any of these, as a heads-up that eBay's own
 * "Illegal drugs and drug paraphernalia" policy may apply to it (confirmed 2026-10-02: a real listing - "RORA Glass
 * Oil Burner Pipe ... Glass Water Bongs" - was taken down by eBay for exactly this).
 *
 * eBay explicitly allows wood/ceramic/stone pipes and tobacco pipes/accessories not intended for drug use - a bare
 * word like "pipe" or "grinder" would flag many unrelated, perfectly legal products, so this list sticks to terms
 * that are specific to drug paraphernalia on their own (glass water pipes, dab rigs, and the accessories/slang that
 * only make sense in that context), not eBay's whole prohibited-items policy (weapons, counterfeit, hazmat, recalled
 * items, ... are a different policy each, not covered here).
 */
const WORDS = `
bong, bongs, water bong, water bongs, glass bong, glass bongs, bong bowl, bong bowls,
dab rig, dab rigs, oil rig, oil rigs, oil burner pipe, oil burner pipes, nectar collector, nectar collectors,
bubbler pipe, bubbler pipes, percolator bong, ash catcher, ash catchers, downstem, downstems,
weed pipe, weed pipes, herb grinder, herb grinders, weed grinder, weed grinders, spoon pipe, spoon pipes,
chillum, chillums, one hitter pipe, one hitter pipes, steamroller pipe, steamroller pipes,
glass blunt, glass blunts, dabber tool, dab tool, dab tools, quartz banger, quartz bangers,
420 pipe, stoner pipe, marijuana pipe, cannabis pipe, weed bowl piece, bowl piece for bong,
whippits, whip-its, nitrous oxide cracker, legal high
`;

function parseList(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** The built-in list, for services/prohibitedItemsService.js's matcher and for showing a seller what is checked. */
function getWords() {
  return [...new Set(parseList(WORDS))].sort();
}

module.exports = { getWords };
