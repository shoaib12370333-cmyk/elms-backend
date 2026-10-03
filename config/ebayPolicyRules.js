/**
 * What eBay does NOT allow, as a starting point that services/prohibitedItemsService.js turns into a matcher: a draft whose text names one of these
 * is stopped by ELMS (never sent to eBay) and the person is told why. Every area is one eBay policy and links to it. An ELMS admin can switch an
 * area off, add terms of their own and list "allowed phrases" (Admin -> eBay rules) without a deploy.
 *
 * Built from eBay's own policy pages (read 2026-10-03):
 *   Firearms and accessories  https://www.ebay.com/help/policies/prohibited-restricted-items/firearms-weapons-knives-policy?id=4277
 *   Weapons / Knives          .../weapons-policy?id=5050   .../knives-policy?id=5047
 *   Illegal drugs & paraphernalia  .../drugs-drug-paraphernalia-policy?id=4333
 *   Tobacco and e-cigarettes  .../tobacco-policy?id=4273
 *   Counterfeit               .../fake-items-policy?id=4276
 *   Animal products           .../animal-products-policy?id=5046
 * and the summaries eBay shows for its Prescription drugs, Electronic equipment (surveillance, jammers), Encouraging illegal activity and
 * Hazardous materials policies.
 *
 * The rule of this list is PRECISION. Nothing here can be undone by the person (a stopped product is simply not listed), so a word that is also an
 * everyday product is NOT here, or only with a context rule. It was checked against the 6,844 titles of a real store (2026-10-03): the first version
 * stopped 6 of them and all 6 were fine ("Wii Controllers with Nunchucks", "No Vaping" signs, a gun SAFE, an incense "ash catcher", a counterfeit
 * money DETECTOR pen, rubber training nunchucks). So: no bare "firearm"/"handgun" (accessories - safes, holsters, cases - are allowed), no
 * "vaporizer" (a humidifier), "ivory" (a colour), "gunpowder" (a tea), "firecracker" (a lipstick), "knockoff" ("not a knockoff"), "mirror quality"
 * (a polish), and a context rule where a word has an innocent twin (`contextRules`: the hit is dropped when one of the `unless` words is in the same text).
 * Whole words and phrases only, matched like the VeRO words (case, hyphens, accents).
 * Only what eBay prohibits outright; what it allows with conditions (pepper spray, stun guns, alcohol, CBD, approval-only brands) is not blocked.
 */
const { getWords: drugParaphernaliaWords } = require('./prohibitedItemWords');

const list = (text) => String(text).split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean);

const POLICY = 'https://www.ebay.com/help/policies/prohibited-restricted-items/';

// Words of the older drug-paraphernalia list that are also everyday products ("oil rig" toys and models, an incense "ash catcher", a kitchen
// "herb grinder", "legal high-waisted" trousers): they stay out now that a match stops a product instead of only warning about it.
const TOO_AMBIGUOUS_TO_STOP = new Set(list(`
  oil rig, oil rigs, ash catcher, ash catchers, herb grinder, herb grinders, dab tool, dab tools, legal high
`));

/** Airsoft, BB, gel-blaster and toy versions of a gun part ("airsoft M4 lower receiver", "Nerf shotgun shells") are not firearms parts. */
const AIRSOFT_TOY = ['airsoft', 'aeg', 'bb', 'bbs', 'nerf', 'toy', 'toys', 'blaster', 'blasters', 'gel', 'paintball', 'pellet', 'pellets', 'airgun', 'foam'];
/** Words that make a hit harmless: a drug TEST KIT names the drugs it tests for. */
const DRUG_TEST = ['test', 'tests', 'testing', 'strip', 'strips', 'panel', 'screen', 'screening'];
/** Foam, rubber and toy versions of a weapon are allowed (eBay: training weapons made of foam), and so are Wii "nunchuk" controllers. */
const TOY_VERSION = ['foam', 'rubber', 'plastic', 'toy', 'toys', 'training', 'practice', 'wii', 'nintendo', 'controller', 'controllers', 'spinner'];

/** Areas, most serious first. `mediaExempt`: not applied to books, films, music and games (they may be ABOUT the subject). */
const AREAS = [
  {
    id: 'firearms',
    label: 'Firearms, ammunition and gun parts',
    reason: 'eBay does not allow firearms, ammunition, silencers or the parts that make a firearm work.',
    url: POLICY + 'firearms-weapons-knives-policy?id=4277',
    mediaExempt: true,
    terms: list(`
      shotgun shell, shotgun shells, bullet casings, shell casings, brass casings, high capacity magazine, high capacity magazines,
      gun silencer, gun silencers, firearm suppressor, firearm suppressors, flash suppressor, solvent trap, solvent traps,
      bump stock, bump fire stock, polymer 80, 80 percent lower, 80% lower, ghost gun, ghost guns, auto sear, glock switch,
      pistol conversion kit, barrel shroud, magazine extender, lower receiver, upper receiver
    `),
    contextRules: [
      { terms: list('shotgun shell, shotgun shells, bullet casings, shell casings, brass casings, high capacity magazine, high capacity magazines, flash suppressor, barrel shroud, magazine extender, lower receiver, upper receiver'), unless: AIRSOFT_TOY },
    ],
  },
  {
    id: 'weapons',
    label: 'Prohibited weapons and knives',
    reason: 'eBay does not allow these weapons or knives (brass knuckles, throwing stars, tasers, switchblade-type and disguised knives and similar).',
    url: POLICY + 'weapons-policy?id=5050',
    mediaExempt: true,
    terms: list(`
      brass knuckles, brass knuckle, knuckle duster, knuckle dusters, nunchaku, nunchakus, nunchuck, nunchucks, sansetsukon, leaded cane,
      throwing star, throwing stars, ninja star, ninja stars, shuriken, throwing knife, throwing knives, blowgun, blowguns,
      blow dart gun, flare gun, potato gun, potato cannon, tear gas, taser, tasers, disguised stun gun,
      switchblade, switchblades, switch blade, automatic knife, automatic knives, butterfly knife, butterfly knives, balisong,
      gravity knife, gravity knives, out the front knife, otf knife, otf knives, push dagger, push knife, paratrooper knife,
      sword cane, cane sword, ballistic knife, belt buckle knife, hidden knife, disguised knife, concealed knife
    `),
    contextRules: [
      { terms: list('nunchaku, nunchakus, nunchuck, nunchucks, throwing star, throwing stars, ninja star, ninja stars, shuriken, throwing knife, throwing knives'), unless: TOY_VERSION },
      { terms: list('switchblade, switchblades, switch blade, butterfly knife, butterfly knives'), unless: ['comb', 'combs'] },
      { terms: list('automatic knife, automatic knives'), unless: ['sharpener', 'sharpeners', 'sharpening', 'block', 'holder', 'stand'] },
      { terms: list('hidden knife, concealed knife, disguised knife'), unless: ['holder', 'block', 'storage', 'sharpener', 'case'] },
    ],
  },
  {
    id: 'drugs',
    label: 'Illegal drugs and drug paraphernalia',
    reason: 'eBay does not allow illegal drugs, drug paraphernalia, THC products, nitrous oxide cream chargers, or items marketed for drug use.',
    url: POLICY + 'drugs-drug-paraphernalia-policy?id=4333',
    mediaExempt: true,
    terms: [...drugParaphernaliaWords().filter((w) => !TOO_AMBIGUOUS_TO_STOP.has(w)), ...list(`
      marijuana seeds, cannabis seeds, kratom, magic mushroom spores, magic mushroom grow kit, magic mushroom gummies, psilocybin, mdma, ecstasy pills,
      cocaine, heroin, methamphetamine, crystal meth, lsd blotter, lsd tab, lsd tabs, ketamine, raw opium, opium tincture, opium resin, fentanyl,
      sarms, clenbuterol, trenbolone, dianabol,
      whipped cream charger, whipped cream chargers, cream charger, cream chargers, smartwhip, galaxy gas,
      thc, delta 8, delta 9
    `)],
    // Not here on purpose: bare "opium" (a perfume), "lsd" (a limited slip differential), "magic mushroom" (a lamp), "marijuana" / "weed leaf" (a T-shirt),
    // "anabolic steroids" ("contains no anabolic steroids"): only phrases that name the drug or the product itself.
    contextRules: [
      { terms: list('cocaine, heroin, methamphetamine, crystal meth, mdma, ecstasy pills, lsd blotter, lsd tab, lsd tabs, ketamine, raw opium, opium tincture, opium resin, fentanyl, psilocybin, thc, delta 8, delta 9'), unless: DRUG_TEST },
      // a whipped-cream DISPENSER is a kitchen tool (its listing says "compatible with N2O cream chargers"); the chargers themselves are what eBay forbids
      { terms: list('whipped cream charger, whipped cream chargers, cream charger, cream chargers'), unless: ['dispenser', 'dispensers', 'whipper', 'whippers', 'siphon', 'siphons'] },
    ],
  },
  {
    id: 'tobacco',
    label: 'Tobacco, e-cigarettes and vaping',
    reason: 'eBay does not allow tobacco, e-cigarettes, e-liquids, vapes and their accessories, or nicotine pouches.',
    url: POLICY + 'tobacco-policy?id=4273',
    mediaExempt: true,
    terms: list(`
      e-cigarette, e-cigarettes, ecigarette, e cig, e-cig, e-cigs, vape, vapes, vaping, vape pen, vape pens, e-liquid, e-liquids,
      e juice, e-juice, vape juice, vape coil, vape coils, vape tank, vape mod, vape battery, vape kit, juul, puff bar, elf bar,
      nicotine pouch, nicotine pouches, nicotine salt, nicotine salts, snus, loose tobacco, rolling tobacco, chewing tobacco,
      pipe tobacco, shisha tobacco, hookah tobacco, herbal cigarettes, cigarillo, cigarillos
    `),
    contextRules: [
      // signs and detectors against vaping are not vaping products
      { terms: list('vape, vapes, vaping'), unless: ['sign', 'signs', 'sticker', 'stickers', 'decal', 'decals', 'detector', 'detectors', 'sensor', 'sensors', 'prohibited', 'banned'] },
    ],
  },
  {
    id: 'prescription',
    label: 'Prescription drugs and medicine',
    reason: 'eBay does not allow prescription drugs or products with prescription-strength medicine, injectable weight-loss or growth-hormone products, or COVID tests.',
    url: POLICY + 'prescription-overthecounter-drugs-policy?id=5048',
    mediaExempt: true,
    terms: list(`
      rx only,
      human growth hormone, hgh injection, semaglutide, tirzepatide, ozempic, wegovy, mounjaro, dermal filler, dermal fillers,
      covid test, covid tests, covid-19 test, covid 19 test, covid antigen, rapid covid, at home covid,
      sildenafil, tadalafil, viagra, cialis, tramadol, oxycodone, adderall, xanax, valium, percocet, ambien
    `),
  },
  {
    id: 'counterfeit',
    label: 'Counterfeit and fake goods',
    reason: 'eBay does not allow counterfeit, fake, replica-of-a-brand or unauthorised-copy goods.',
    url: POLICY + 'fake-items-policy?id=4276',
    mediaExempt: false,
    terms: list(`
      counterfeit, counterfeits, fake designer, replica designer, replica watch, replica watches,
      replica handbag, replica handbags, replica bag, replica bags, replica sneakers, replica shoes, super fake, 1:1 replica,
      aaa quality replica, unauthorized copy, unauthorised copy
    `),
    contextRules: [
      // a counterfeit-money pen / detector / marker is a tool against counterfeits
      { terms: list('counterfeit, counterfeits'), unless: ['detector', 'detectors', 'detection', 'detect', 'pen', 'pens', 'marker', 'markers', 'checker', 'tester', 'scanner', 'anti', 'prevention', 'proof', 'authentic', 'verify', 'verification'] },
    ],
  },
  {
    id: 'pirated',
    label: 'Pirated media and software',
    reason: 'eBay does not allow pirated, cracked or illegally copied software, films, music and streaming services.',
    url: 'https://www.ebay.com/help/policies/prohibited-restricted-items/prohibited-and-restricted-items-policy?id=4288',
    mediaExempt: false,
    terms: list(`
      pirated, pirate copy, cracked software, software crack, keygen, mod apk, iptv subscription, iptv subscriptions,
      jailbroken firestick, jailbroken fire stick, fully loaded kodi, fully loaded firestick, fully loaded fire stick,
      burned dvd, burnt dvd, bootleg dvd
    `),
  },
  {
    id: 'wildlife',
    label: 'Ivory and protected animal products',
    reason: 'eBay does not allow ivory (of any age) or products from endangered and protected animals.',
    url: POLICY + 'animal-products-policy?id=5046',
    mediaExempt: true,
    terms: list(`
      elephant ivory, real ivory, genuine ivory, walrus ivory, hippo ivory, hippopotamus ivory, narwhal ivory,
      dried shark fin, shark fin soup, real tortoiseshell, genuine tortoiseshell, real tortoise shell, genuine tortoise shell, sea turtle shell
    `),
  },
  {
    id: 'surveillance',
    label: 'Hidden cameras and signal jammers',
    reason: 'eBay does not allow cameras or recorders sold to record people without their knowledge, nor signal jammers.',
    url: POLICY + 'electronic-equipment-policy?id=4302',
    mediaExempt: true,
    terms: list(`
      spy camera, spy cameras, hidden camera, hidden cameras, hidden spy, spy pen camera, covert camera, secret camera,
      record without knowledge, record without their knowledge, record without knowing,
      signal jammer, signal jammers, cell phone jammer, phone jammer, gps jammer, wifi jammer, wi-fi jammer, radar jammer, laser jammer
    `),
  },
  {
    id: 'illegal_activity',
    label: 'Fake documents and card skimmers',
    reason: 'eBay does not allow items that help break the law, such as fake IDs and documents or card skimmers.',
    url: POLICY + 'encouraging-illegal-activity-policy?id=4339',
    mediaExempt: true,
    terms: list(`
      fake id, fake ids, fake driver license, fake drivers license, fake driver's license, fake passport, fake diploma, fake degree,
      fake transcript, fake vaccine card, fake vaccination card, fake pay stub, credit card skimmer, card skimmer, atm skimmer
    `),
    contextRules: [
      { terms: list('fake id, fake ids'), unless: ['detector', 'detectors', 'scanner', 'scanners', 'checker', 'verification', 'reader'] },
      // an RFID wallet says it protects against card skimmers
      { terms: list('credit card skimmer, card skimmer, atm skimmer'), unless: ['rfid', 'blocking', 'blocker', 'protect', 'protects', 'protection', 'protector', 'anti', 'wallet', 'wallets', 'sleeve', 'sleeves', 'shield', 'guard'] },
    ],
  },
  {
    id: 'explosives',
    label: 'Fireworks and explosives',
    reason: 'eBay does not allow fireworks, explosives or items to make them.',
    url: POLICY + 'hazardous-restricted-regulated-materials-policy?id=4335',
    mediaExempt: true,
    terms: list(`
      consumer fireworks, aerial fireworks, smokeless powder, blasting cap, blasting caps, tannerite
    `),
  },
];

/**
 * Phrases that contain a term above but are ordinary, allowed products ("THC free", "hidden camera detector"): cut out of the text before it is
 * checked. An admin can add more (Admin -> eBay rules).
 */
const ALLOW_PHRASES = list(`
  thc free, free of thc, no thc, non thc, zero thc, without thc, 0% thc, 0.0% thc,
  hidden camera detector, hidden camera detectors, hidden camera finder, spy camera detector, spy camera finder,
  anti counterfeit, bootleg jeans, bootleg pants, bootleg cut, bootleg fit, no vaping, no smoking or vaping, vape free,
  shisha tobacco free, hookah tobacco free
`);

module.exports = { AREAS, ALLOW_PHRASES };
