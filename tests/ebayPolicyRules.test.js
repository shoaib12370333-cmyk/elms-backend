// eBay's list of what it does not allow (config/ebayPolicyRules.js) and its matcher (services/prohibitedItemsService.js): a product that names one of
// these is stopped by ELMS (see publishPolicyGate.test.js). Nothing here can be undone by the person, so the rule is PRECISION: every term must catch
// what it is meant to, and ordinary products that merely share a word ("vaporizer", "ivory" the colour, "gunpowder" tea) must never be caught.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// the admin's settings come from this stand-in for MongoDB
let stored = null; let reads = 0; let failRead = false;
stub('models/schemas/Settings', {
  findOne: () => ({ lean: async () => { reads += 1; if (failRead) throw new Error('database is down'); return stored; } }),
});

const P = require('../services/prohibitedItemsService');
let connected = true;
P.deps.isConnected = () => connected; // the stand-in database below answers only while "connected"
const { AREAS, ALLOW_PHRASES } = require('../config/ebayPolicyRules');
const areaOf = (title, extra = {}, options) => P.scanDetailed({ title, ...extra }, options).map((h) => h.areaId);
const termsOf = (title, extra = {}, options) => P.scanDetailed({ title, ...extra }, options).map((h) => h.term);

(async () => {
  // ---------- the list itself ----------
  assert.deepStrictEqual(AREAS.map((a) => a.id), ['firearms', 'weapons', 'drugs', 'tobacco', 'prescription', 'counterfeit', 'pirated', 'wildlife', 'surveillance', 'illegal_activity', 'explosives']);
  for (const a of AREAS) {
    assert.ok(a.label && a.reason && /^https:\/\/www\.ebay\.com\/help\/policies\//.test(a.url), a.id + ' names its eBay policy page');
    assert.ok(a.terms.length >= 5, a.id + ' has terms');
    assert.strictEqual(new Set(a.terms).size, a.terms.length, a.id + ' has no duplicate term');
    for (const t of a.terms) assert.ok(t === t.toLowerCase() && t === t.trim() && t.length >= 2 && t.length <= 60, a.id + ': a usable term: ' + JSON.stringify(t));
  }
  assert.strictEqual(AREAS.find((a) => a.id === 'counterfeit').mediaExempt, false); assert.strictEqual(AREAS.find((a) => a.id === 'pirated').mediaExempt, false);
  assert.ok(AREAS.filter((a) => a.mediaExempt).length === 9);

  // every built-in term really is found in a plain sentence (the matcher builds correctly for all of them: %, :, hyphens, apostrophes)
  const key = (s) => s.toLowerCase().replace(/[\s\-'.]+/g, '');
  for (const a of AREAS) {
    for (const t of a.terms) {
      const owner = AREAS.find((x) => x.terms.some((y) => key(y) === key(t)));
      const hits = P.scanDetailed({ title: 'New ' + t + ' for sale' });
      assert.ok(hits.some((h) => key(h.term) === key(t) && h.areaId === owner.id), a.id + ': "' + t + '" is found, got ' + JSON.stringify(hits.map((h) => h.term)));
    }
  }
  // ...and every always-fine phrase on its own is NOT flagged although it contains a term
  for (const phrase of ALLOW_PHRASES) assert.deepStrictEqual(P.scanDetailed({ title: 'Best ' + phrase + ' 2 pack' }).map((h) => h.term), [], 'allowed: ' + phrase);

  // ---------- what must be stopped (one real-looking title per area) ----------
  const MUST = [
    ['firearms', 'Ghost Gun 80% Lower Receiver Kit'], ['firearms', 'Glock Switch Auto Sear Conversion'], ['firearms', 'Rifle Ammo 223 Brass Casings 500 count'],
    ['weapons', 'Brass Knuckles Metal Self Defense'], ['weapons', 'Ninja Throwing Stars Shuriken Set'], ['weapons', 'Butterfly Knife Balisong Trainer'], ['weapons', 'Wooden Nunchucks Martial Arts'], ['weapons', 'Taser Pen Personal Protection'],
    ['drugs', 'RORA Glass Oil Burner Pipe Thick Clear Glass for Oil Rigs Glass Water Bongs'], ['drugs', 'Whipped Cream Chargers 50 Pack N2O'], ['drugs', 'Kratom Powder 1kg'], ['drugs', 'Hemp Gummies with THC 25mg'], ['drugs', 'Marijuana Seeds Feminized 10 Pack'], ['drugs', 'LSD Blotter Paper Tabs'], ['drugs', 'Magic Mushroom Grow Kit Monotub'], ['drugs', 'Raw Opium Resin 10g'],
    ['tobacco', 'Disposable Vape Pen 5000 Puffs'], ['tobacco', 'Strawberry E-Liquid 60ml Vape Juice'], ['tobacco', 'Nicotine Pouches Mint Strong'], ['tobacco', 'Elf Bar BC5000 Blue Razz'],
    ['prescription', 'Ozempic Semaglutide Pen 2mg'], ['prescription', 'COVID-19 Test Kit Rapid Antigen 10 Pack'], ['prescription', 'Viagra 100mg Tablets'],
    ['counterfeit', 'Rolex Replica Watches AAA Mirror Quality'], ['counterfeit', 'Replica Designer Handbag Gucci Style'], ['counterfeit', 'Louis Vuitton Counterfeit Wallet'],
    ['pirated', 'Fully Loaded Kodi Box Jailbroken Fire Stick'], ['pirated', 'Photoshop Cracked Software Keygen'],
    ['wildlife', 'Carved Elephant Ivory Pendant'], ['wildlife', 'Narwhal Ivory Tusk 60 inch'], ['wildlife', 'Dried Shark Fin 500g'],
    ['surveillance', 'Wireless Hidden Spy Camera Clock'], ['surveillance', 'Cell Phone Signal Jammer 5 Band'], ['surveillance', 'Spy Pen Camera 1080p'],
    ['illegal_activity', 'Fake ID Card Maker Template'], ['illegal_activity', 'Credit Card Skimmer Reader'],
    ['explosives', 'Aerial Fireworks Cake 500 Gram'], ['explosives', 'Tannerite Exploding Target 1lb'],
  ];
  for (const [area, title] of MUST) assert.ok(areaOf(title).includes(area), `${area}: "${title}" is stopped, got ${JSON.stringify(areaOf(title))}`);

  // ---------- what must NEVER be stopped: ordinary products that share a word with the list ----------
  const FINE = [
    'Cool Mist Vaporizer Humidifier for Bedroom', 'Steam Vaporizer Inhaler Nasal', 'Ivory White Curtains 84 inch Blackout', 'Antique Ivory Chalk Paint 500ml',
    'Gunpowder Green Tea 250g Loose Leaf', 'Shark Fin Antenna for Car Roof', 'Car Cigarette Lighter Adapter 12V USB Charger', 'Cigarette Case Holder Aluminium',
    'Threaded Barrel Nipple 1/2 inch Black Pipe', 'Stainless Steel Kitchen Knife Set 6 Pieces', 'Electric Coffee Bean Grinder', 'Wooden Tobacco Pipe Briar',
    'Nerf Elite Dart Gun Blaster Toy', 'Hot Glue Gun Mini 20W', 'Staple Gun Heavy Duty', 'Air Blow Gun Kit for Compressor', 'Water Gun Super Soaker',
    'Pepper Spray Keychain 0.5oz', 'Stun Gun Flashlight Rechargeable', 'Black Powder Coat Paint 1 gallon', 'Detonator Hair Wax Strong Hold',
    'Cherry Bomb Lip Gloss', 'Bear Claw Meat Shredder Set', 'Tortoise Shell Pattern Glasses Frames', 'Bootleg Jeans Women Stretch Flare', 'Nightstick Tactical Flashlight USB',
    'Botox Alternative Anti Wrinkle Cream', 'Hidden Camera Detector Anti Spy Bug Finder', 'Counterfeit Money Detector Pen 10 Pack', 'Fake ID Scanner Checker Verification',
    'Foam Nunchucks Training Martial Arts Kids', 'Hemp Seed Oil Cannabis Sativa Skin Care', 'THC Free Hemp Rope 100ft', 'Plant Pot Planter Ceramic',
    'Cannabis Sativa Seed Oil Shampoo', 'Prescription Strength Anti Itch Cream', 'Smoke Alarm Detector 10 Year',
    // the six titles of a real store (6,844 live listings, checked 2026-10-03) that the FIRST version of the list stopped, all fine:
    'Motion Plus Wii Controllers 2Packs with Nunchucks, Wii Remote Controllers Compatible for wii and Wii U with Built in Motion',
    'EVQ No Smoking No Vaping Sticker Sign Tape 2 x 4 Vinyl Window Decal 200 PCS',
    'Dalmbox Compact Portable Handgun Pistol Gun Safe Lock Box for Car & Travel',
    'Nunchucks - Safe Solid Rubber Training Nunchucks/Nunchakus with Steel Chain, Suitable for Adults, Professionals to Perform',
    'Insence-Stick Holder [Anti-Ash Flying], Modern Incense Burner Holder with Removable Glass Ash Catcher, for Home Decor',
    'Huron Counterfeit Money Marker Detector Pen (5/15/50/150/375/1500) (5)',
    // more twins: a comb, a sharpener, a lipstick, a kitchen tool, a polish, a toy, a test kit, a holster, a seller's promise
    'Switchblade Comb Black Folding Pocket', 'Automatic Knife Sharpener Electric 3 Stage', 'Firecracker Red Lipstick Matte', 'Herb Grinder Spice Mill for Kitchen',
    'Mirror Quality Stainless Steel Polish Kit', 'Toy Grenade Launcher Foam Blaster for Kids', 'Multi Drug Test Cup 12 Panel THC COC OPI MET MDMA',
    'Handgun Holster Leather IWB', 'Firearm Cleaning Kit 20 Piece', 'Ninja Star Foam Throwing Toy 6 Pack', 'Vape Detector Sensor for School Bathrooms',
    'Fake ID Scanner Age Verification Reader', 'Legal High-Waisted Leggings', 'Red Firecracker Hot Sauce 5oz',
    // twins found by the independent review of this list: a perfume, a differential, a lamp, a plush, a leaf on a sock, an airsoft part, a nerf refill, a cream DISPENSER, a skimmer-proof wallet, tobacco-free shisha
    'YSL Opium Eau de Parfum 90ml Women', 'Torsen LSD Limited Slip Differential Gearbox Rear', 'Magic Mushroom Lamp Night Light USB Mushroom Table Lamp', 'Magic Mushroom Plush Toy 12 inch',
    'Marijuana Leaf Socks Funny Cotton Crew', 'Weed Leaf Cannabis Leaf Print T-Shirt Mens', 'Airsoft M4 Hi-Cap Magazine 300 Round High Capacity Magazines for AEG', 'Airsoft M4 Lower Receiver Metal Body AEG',
    'Nerf Compatible Shotgun Shells Refill 24 Pack Soft Foam', 'Whipped Cream Dispenser Stainless Steel 500ml Compatible with N2O Cream Chargers',
    'RFID Blocking Wallet Mens Slim Protects Against Credit Card Skimmer', 'Al Fakher Shisha Tobacco Free Molasses 250g', 'Anabolic Steroid Free Protein Powder Vanilla 2lb',
  ];
  for (const title of FINE) assert.deepStrictEqual(areaOf(title), [], `"${title}" is an ordinary product: ${JSON.stringify(termsOf(title))}`);

  // the same twins in a DESCRIPTION / bullet point (ordinary wording of ordinary products)
  for (const extra of [
    { description: 'A weekly pill box to hold your prescription medication, vitamins and prescription drugs.' }, { bulletPoints: ['Keeps your prescription medications sorted'] },
    { description: 'Contains no anabolic steroids, no banned substances.' }, { specifications: [{ name: 'Note', value: 'Smells like opium and amber (perfume notes: opium, jasmine)' }] },
    { description: 'Fits all standard N2O cream chargers. Whipped cream dispenser only.' },
  ]) assert.deepStrictEqual(areaOf('An Everyday Product', extra), [], JSON.stringify(extra));
  assert.ok(areaOf('Whipped Cream Chargers 24 Pack').includes('drugs'), 'the chargers themselves stay stopped');
  assert.ok(areaOf('Credit Card Skimmer Device ATM Overlay').includes('illegal_activity') && areaOf('Card Skimmer Reader Writer').includes('illegal_activity'));
  assert.ok(areaOf('AR-15 80% Lower Receiver Aluminium').includes('firearms'), 'a real lower receiver is stopped');
  assert.ok(areaOf('Shotgun Shells 12 Gauge Buckshot 25 Rounds').includes('firearms'));

  // ---------- context rules: the hit is dropped only when a context word is in the same text, as a whole word, and only for the terms the rule names ----------
  assert.ok(areaOf('Real Nunchucks Stoyan Brand').includes('weapons'), '"toy" inside "Stoyan" is not a toy');
  assert.ok(areaOf('Wooden Nunchucks Martial Arts').includes('weapons'));
  assert.deepStrictEqual(areaOf('Wooden Nunchucks Wii Edition'), [], 'a context word anywhere in the field');
  assert.ok(areaOf('Brass Knuckles Foam Padded Case').includes('weapons'), 'the toy words only soften the terms their rule names (brass knuckles are not one)');
  assert.ok(areaOf('THC Gummies 25mg', { description: 'a drug test is not needed' }).includes('drugs'), 'the context word is looked for in the SAME field: a "test" in the description does not excuse the title');
  assert.ok(areaOf('Strong THC Gummies 50 Pack').includes('drugs'));
  assert.deepStrictEqual(areaOf('THC Test Strips 10 Pack'), []);
  assert.ok(areaOf('Counterfeit Rolex Watches').includes('counterfeit') && areaOf('Counterfeit Money Detector').length === 0);
  assert.ok(areaOf('Fake ID Maker Kit').includes('illegal_activity') && areaOf('Fake ID Scanner').length === 0);
  assert.ok(areaOf('Disposable Vape Pen').includes('tobacco') && areaOf('No Vape Sign Sticker').length === 0 && areaOf('Vape Detector for Schools').length === 0);
  assert.ok(areaOf('Butterfly Knife Balisong Steel').includes('weapons') && areaOf('Butterfly Knife Comb').length === 0);
  assert.ok(areaOf('Automatic Knife OTF Black').includes('weapons') && areaOf('Automatic Knife Sharpener').length === 0);
  // the title says what the product is: its context word excuses the same term in the OTHER fields (a real live listing, 2026-10-03: the title says Rubber Training Nunchucks, a bullet point says just "Nunchakus")
  const rubberNunchucks = { description: 'Nunchakus\nImported\nsolid rubber nunchaku with strong steel chain', bulletPoints: ['Nunchakus', 'Imported', 'Sturdy solid rubber nunchaku with steel chain'], specifications: [{ name: 'Best Sellers Rank', value: '#24 in Martial Arts Cord Nunchakus' }] };
  assert.deepStrictEqual(areaOf('Nunchucks - Safe Solid Rubber Training Nunchucks/Nunchakus with Steel Chain', rubberNunchucks), []);
  assert.ok(areaOf('Real Martial Arts Nunchucks Steel Chain', { bulletPoints: ['Nunchaku, rubber grip'], description: 'rubber handle, a training favourite' }).includes('weapons'), 'a context word in a bullet point or the description never excuses the TITLE');
  assert.ok(areaOf('Martial Arts Nunchaku Wooden', { bulletPoints: ['Nunchakus'] }).includes('weapons'), 'no context word in the title: the other fields count on their own');
  assert.ok(areaOf('Rubber Training Nunchucks', { bulletPoints: ['Brass Knuckles included'] }).includes('weapons'), 'the toy word of the title only softens the terms its rule names');

  // the tobacco rule excuses "vape" in a sign; if the admin also lists "vape" under drugs (which comes first), THAT area's hit is not excused by it
  assert.deepStrictEqual(areaOf('No Vape Sign Sticker', {}, { settings: { extraTerms: [{ area: 'drugs', term: 'vape' }] } }), ['drugs']);

  // ---------- spelling: hyphens, spaces, none, case, accents ----------
  for (const t of ['Glass Water-Bong 14mm', 'GLASS WATER BONG', 'glass waterbong', 'Glass Wàter Bóng']) assert.ok(areaOf(t).includes('drugs'), t);
  assert.ok(areaOf('E-Cigarette Starter Set').includes('tobacco') && areaOf('e cigarette starter').includes('tobacco') && areaOf('ecigarette starter').includes('tobacco'));
  assert.ok(areaOf('Sword’s Edge Butterfly-Knife').includes('weapons'), 'curly quotes and hyphens');
  // whole words only
  for (const t of ['African Bongo Drum', 'Vapeful Perfume', 'Cocainelike Colour', 'Taserlike Name', 'Snusnu Plush', 'Superbong Brand', 'Pretaser Gadget', 'Xvape Case']) assert.deepStrictEqual(areaOf(t), [], t);
  // the longest term wins where one contains another
  assert.deepStrictEqual(termsOf('Glass Water Bongs 2 Set'), ['water bongs']);

  // ---------- where it looks: title, description (HTML), bullet points, specifications, item specifics, brand ----------
  const where = (extra) => P.scanDetailed({ title: 'A Plain Thing', ...extra }).map((h) => h.field + ':' + h.areaId);
  assert.deepStrictEqual(where({ description: '<div><p>Great for <b>vape pen</b> fans</p></div>' }), ['description:tobacco']);
  assert.deepStrictEqual(where({ description: '<span class="vape pen">harmless</span>' }), [], 'words inside an HTML tag are not text');
  assert.deepStrictEqual(where({ bulletPoints: ['Durable', 'Works as a Taser'] }), ['bulletPoints:weapons']);
  assert.deepStrictEqual(where({ specifications: [{ name: 'Type', value: 'Hidden Spy Camera' }] }), ['specifications:surveillance']);
  assert.deepStrictEqual(where({ aspects: { Type: ['E-Liquid'] } }), ['aspects:tobacco']);
  assert.deepStrictEqual(where({ brand: 'Elf Bar' }), ['brand:tobacco']);
  assert.deepStrictEqual(P.scanListing({ title: 'Vape Pen And Vape Pen', description: 'vape pen' }), ['vape pen'], 'scanListing: the words, once each');
  assert.deepStrictEqual(P.scanDetailed({}), []); assert.deepStrictEqual(P.scanDetailed(undefined), []); assert.deepStrictEqual(P.scanListing(null), []);

  // ---------- books, films, music and games may be ABOUT a subject: exempt, except counterfeit and pirated ----------
  assert.deepStrictEqual(areaOf('The Cocaine Chronicles: A Novel', { categories: ['Books', 'Literature & Fiction'] }), []);
  assert.deepStrictEqual(areaOf('Firearms of the Civil War', { categories: ['Movies & TV', 'Documentary'] }), []);
  assert.deepStrictEqual(areaOf('Vape Culture Soundtrack', { categories: ['CDs & Vinyl'] }), []);
  assert.deepStrictEqual(areaOf('Psilocybin Grower Handbook', { categories: ['Kindle Store'] }), []);
  assert.deepStrictEqual(areaOf('Psilocybin Grower Handbook', { categories: ['Video Games'] }), []);
  assert.ok(areaOf('Psilocybin Grower Handbook').includes('drugs'), 'the same title outside a book category is stopped');
  assert.ok(areaOf('The Cocaine Chronicles', { categories: ['Home & Kitchen'] }).includes('drugs'), 'not a book: stopped');
  assert.ok(areaOf('The Cocaine Chronicles').includes('drugs'), 'no category known: stopped');
  assert.ok(areaOf('Bootleg DVD Concert', { categories: ['Movies & TV'] }).includes('pirated'), 'a bootleg DVD is stopped even in the Movies category');
  assert.ok(areaOf('Rolex Replica Watches', { categories: ['Books'] }).includes('counterfeit'), 'counterfeit is never exempt');
  assert.ok(areaOf('Cracked Software Keygen', { categories: ['Books'] }).includes('pirated'), 'pirated is never exempt');
  assert.deepStrictEqual(areaOf('Musical Instrument Cocaine Pedal', { categories: ['Musical Instruments'] }).length, 1, '"Musical" is not "Music"');

  // ---------- the person is told: the first problem, its policy, where, and how many more ----------
  const hits = P.scanDetailed({ title: 'Disposable Vape Pen', description: 'with Hidden Spy Camera' });
  assert.deepStrictEqual(hits.map((h) => h.areaId), ['tobacco', 'surveillance']);
  assert.strictEqual(P.describe(hits), 'Not allowed on eBay (Tobacco, e-cigarettes and vaping): "vape pen" is in the title. eBay does not allow tobacco, e-cigarettes, e-liquids, vapes and their accessories, or nicotine pouches. ELMS will not list this product (1 more problem found).');
  assert.match(P.describe(P.scanDetailed({ title: 'Ghost Gun', description: 'ghost guns', bulletPoints: ['Taser', 'Brass Knuckles'] })), /\(3 more problems found\)\.$/);
  assert.strictEqual(P.describe([]), ''); assert.strictEqual(P.describe(undefined), '');

  // ---------- one listing against the list: the text that would reach eBay (own edits first, the import otherwise) ----------
  const imported = { title: 'Disposable Vape Pen', description: 'Fine', bulletPoints: ['Easy'], specifications: [], ebayAspects: {}, brand: 'Acme', categories: ['Electronics'] };
  let v = P.checkListing({ title: null, description: '' }, imported);
  assert.deepStrictEqual([v.blocked, v.hits.map((h) => h.areaId)], [true, ['tobacco']]);
  assert.match(v.message, /^Not allowed on eBay \(Tobacco/);
  v = P.checkListing({ title: 'Portable Phone Charger' }, imported);
  assert.deepStrictEqual([v.blocked, v.message], [false, ''], 'the person renamed it: the title that would be sent is clean');
  v = P.checkListing({ title: 'Portable Phone Charger', bullet_points: ['Great for travel'], specifications: [{ name: 'Use', value: 'vape coil' }] }, { ...imported, title: 'x', bulletPoints: ['Taser inside'], specifications: [{ name: 'Use', value: 'Hidden Spy Camera' }] });
  assert.deepStrictEqual(v.hits.map((h) => h.field + ':' + h.areaId), ['specifications:tobacco'], 'edited bullet points and specifications replace the imported ones (their Taser / Spy Camera are not sent)');
  v = P.checkListing({ title: 'Portable Charger', ebay_aspects: { Type: ['E-Juice'] } }, { ...imported, title: 'x' });
  assert.deepStrictEqual(v.hits.map((h) => h.field), ['aspects']);
  v = P.checkListing({}, { ...imported, title: 'Heroin Chic Poster', categories: ['Books'] });
  assert.strictEqual(v.blocked, false, 'the product category (a book) exempts it');
  assert.deepStrictEqual(P.checkListing(null, null), { blocked: false, hits: [], message: '' });

  // ---------- the admin's settings ----------
  const S = (s) => ({ settings: s });
  assert.deepStrictEqual(areaOf('Vape Pen', {}, S({ disabledAreas: ['tobacco'] })), [], 'an area switched off');
  assert.ok(areaOf('Taser', {}, S({ disabledAreas: ['tobacco'] })).includes('weapons'), 'the others stay');
  assert.deepStrictEqual(areaOf('Acme Foo Widget', {}, S({ extraTerms: [{ area: 'tobacco', term: 'foo widget' }] })), ['tobacco'], 'a term added to an area');
  assert.deepStrictEqual(P.scanDetailed({ title: 'Acme Foo Widget' }, S({ extraTerms: [{ area: 'tobacco', term: 'foo widget' }] }))[0].label, 'Tobacco, e-cigarettes and vaping');
  assert.deepStrictEqual(areaOf('Acme Foo Widget', {}, S({ extraTerms: [{ area: 'custom', term: 'Foo Widget' }] })), ['custom'], 'a term of the admin\'s own');
  assert.strictEqual(P.scanDetailed({ title: 'Acme Foo-Widget' }, S({ extraTerms: [{ area: 'custom', term: 'Foo Widget' }] }))[0].label, 'Added by the ELMS admin');
  assert.deepStrictEqual(areaOf('Acme Foo Widget', {}, S({ disabledAreas: ['tobacco'], extraTerms: [{ area: 'tobacco', term: 'foo widget' }] })), [], 'an added term of an area that is off does not count');
  assert.deepStrictEqual(areaOf('Ninja Throwing Stars Metal Set', {}, S({ allowPhrases: ['metal set'] })).length, 1, 'a phrase that does not contain the term changes nothing');
  assert.deepStrictEqual(areaOf('Rubber Practice Taser Prop', {}, S({ allowPhrases: ['practice taser prop'] })), [], 'an allowed phrase is cut out before the check');
  assert.deepStrictEqual(areaOf('Glass Water Bong Cleaner Brush', {}, S({ allowPhrases: ['water bong cleaner'] })), [], 'allowed phrases keep their spelling tolerance');
  assert.ok(areaOf('Glass Water Bong and Taser', {}, S({ allowPhrases: ['taser'] })).includes('drugs'), 'only the allowed words are let through');

  // what may be saved
  const N = P.normalizeSettings;
  assert.deepStrictEqual(N(undefined), { disabledAreas: [], extraTerms: [], allowPhrases: [] });
  assert.deepStrictEqual(N({ disabledAreas: ['tobacco', 'tobacco', 'nope', 7], extraTerms: [{ area: 'weapons', term: '  Foo   Bar ' }, { area: 'weapons', term: 'foo-bar' }, { area: 'unknown', term: 'zzz' }, { area: 'custom', term: 'x' }, { area: 'custom', term: 'a'.repeat(61) }, 'plain', { area: 'drugs', term: '   ' }], allowPhrases: ['  Good Thing ', 'good thing', '', 'x', 'ok'] }),
    { disabledAreas: ['tobacco'], extraTerms: [{ area: 'weapons', term: 'foo bar' }, { area: 'custom', term: 'plain' }], allowPhrases: ['good thing', 'ok'] });
  assert.strictEqual(N({ extraTerms: Array.from({ length: 600 }, (_, i) => ({ area: 'custom', term: 'term' + i })) }).extraTerms.length, P.MAX_EXTRA_TERMS);
  assert.strictEqual(N({ allowPhrases: Array.from({ length: 400 }, (_, i) => 'phrase ' + i) }).allowPhrases.length, P.MAX_ALLOW_PHRASES);

  // ---------- the settings come from the database, at most once a minute, and never break anything ----------
  stored = { ebayPolicy: { disabledAreas: ['weapons'], extraTerms: [{ area: 'custom', term: 'zorp' }], allowPhrases: [] } };
  reads = 0;
  await P.refreshSettings({ force: true });
  assert.strictEqual(reads, 1); assert.deepStrictEqual(P.currentSettings().disabledAreas, ['weapons']);
  assert.deepStrictEqual(areaOf('Taser Zorp'), ['custom'], 'the loaded settings are what the plain scan uses');
  await P.refreshSettings(); await P.refreshSettings();
  assert.strictEqual(reads, 1, 'within a minute nothing is read again');
  stored = { ebayPolicy: { disabledAreas: [], extraTerms: [], allowPhrases: [] } };
  await P.refreshSettings({ force: true });
  assert.strictEqual(reads, 2); assert.ok(areaOf('Taser').includes('weapons'));
  failRead = true; stored = { ebayPolicy: { disabledAreas: ['weapons'], extraTerms: [], allowPhrases: [] } };
  const back = await P.refreshSettings({ force: true });
  assert.ok(areaOf('Taser').includes('weapons') && back.disabledAreas.length === 0, 'a database that is down keeps the last good settings and does not throw');
  // a failed read is tried again soon (15 s), not on every request and not only after a minute
  reads = 0; failRead = false;
  await P.refreshSettings();
  assert.strictEqual(reads, 0, 'right after a failure nothing is read again');
  const realNow = Date.now;
  Date.now = () => realNow() + 20 * 1000;
  try { await P.refreshSettings(); } finally { Date.now = realNow; }
  assert.strictEqual(reads, 1, '20 seconds later it is');
  assert.deepStrictEqual(P.currentSettings().disabledAreas, ['weapons'], 'and the new settings are in use');
  // no connection: nothing is read at all (a query would only wait ten seconds and fail)
  reads = 0; connected = false;
  await P.refreshSettings({ force: true });
  assert.strictEqual(reads, 0); assert.deepStrictEqual(P.currentSettings().disabledAreas, ['weapons'], 'the last settings stay');
  connected = true;
  stored = null; await P.refreshSettings({ force: true });
  assert.deepStrictEqual(P.currentSettings(), { disabledAreas: [], extraTerms: [], allowPhrases: [] }, 'no settings saved yet: the defaults');
  P.setSettings({ disabledAreas: ['tobacco'] });
  assert.deepStrictEqual(areaOf('Vape Pen'), [], 'setSettings is used at once');
  P.setSettings({});

  // ---------- speed: every row of every Drafts / Live listings page is scanned, so a long description must stay cheap ----------
  const words = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i).repeat(5));
  const long = '<div><h2>Product</h2><p>' + Array.from({ length: 4000 }, (_, i) => words[i % 26] + ' ' + words[(i * 7) % 26]).join(' ') + '</p></div>';
  const rows = Array.from({ length: 300 }, () => ({ title: 'An Ordinary Product Title', description: long, bulletPoints: ['Durable', 'Lightweight'], specifications: [{ name: 'Color', value: 'Blue' }] }));
  const t0 = Date.now();
  rows.forEach((r) => P.scanDetailed(r));
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `300 rows with a 4000-word description took ${ms}ms - expected well under 3000ms`);

  // ... and with the admin words saved: the settings are cleaned and compiled ONCE, not for every row (it used to be ~25x slower per row)
  P.setSettings({ extraTerms: Array.from({ length: 300 }, (_, i) => ({ area: i % 2 ? 'custom' : 'drugs', term: 'zorp widget ' + i })), allowPhrases: Array.from({ length: 100 }, (_, i) => 'fine thing ' + i) });
  const shortRows = Array.from({ length: 2000 }, (_, i) => ({ title: 'Ordinary Product Number ' + i, description: 'A short description of an ordinary thing.', bulletPoints: ['Durable'] }));
  const t1 = Date.now();
  shortRows.forEach((r) => P.scanDetailed(r));
  const ms2 = Date.now() - t1;
  assert.ok(ms2 < 1500, `2000 short rows with the admin words took ${ms2}ms - expected well under 1500ms`);
  assert.deepStrictEqual(areaOf('Acme Zorp Widget 7'), ['custom'], 'the admin words still apply');
  // not just fast: the settings OBJECT in use is cleaned and compiled once (so such an object must never be edited after it has been used - setSettings replaces it)
  const used = { extraTerms: [{ area: 'custom', term: 'first word' }] };
  const compiledOnce = P.compile(used);
  used.extraTerms.push({ area: 'custom', term: 'second word' });
  assert.strictEqual(P.compile(used), compiledOnce, 'the same settings object is not compiled again');
  assert.notStrictEqual(P.compile({ extraTerms: [{ area: 'custom', term: 'first word' }, { area: 'custom', term: 'second word' }] }), compiledOnce, 'a new object with other words is');
  P.setSettings({});

  console.log('ebay policy rules tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
