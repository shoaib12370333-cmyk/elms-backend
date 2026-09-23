/**
 * Words that put an eBay seller at risk: brand / character / trademark names that rights owners police through
 * eBay's VeRO programme, and claims eBay bans outright (replica, fake, ...). A listing that uses one of them
 * can be removed and, when it repeats, the seller account can be restricted or suspended.
 *
 * This is a STARTER list of the names that hit dropshippers most. eBay's own VeRO participant list is far
 * bigger and changes all the time, so extra words can be added without a code change through the
 * VERO_EXTRA_WORDS environment variable (comma or new-line separated).
 *
 * Deliberately left out: ordinary English words that are also brand names (apple, coach, jordan, supreme,
 * beats, galaxy, nest, ...) and short letter codes (hp, lg, 3m), to avoid flagging normal listings.
 * Their product names (iphone, air jordan, beats by dre, ...) are on the list.
 */

// Claims and phrases eBay does not allow (counterfeit / "inspired by" wording).
const CLAIM_WORDS = `
replica, replicas, counterfeit, fake, knockoff, knock-off, knock off, bootleg, dupe, dupes, clone,
lookalike, look-alike, look alike, inspired by, 1:1 copy, mirror quality, aaa quality, super copy,
unauthorized, not authentic, not genuine, unlicensed, grey market, gray market
`;

// Brands, characters and trademarks.
const BRAND_WORDS = `
nike, air jordan, air max, adidas, yeezy, puma, reebok, under armour, new balance, converse all star, chuck taylor,
asics, hoka, fila, skechers, crocs, birkenstock, ugg, timberland, dr martens, dr. martens, the north face, north face,
patagonia, lululemon, carhartt, levi's, levis, calvin klein, tommy hilfiger, ralph lauren, polo ralph lauren, lacoste,
off-white, bape, stussy, gucci, louis vuitton, chanel, prada, hermes, dior, christian dior, burberry, versace,
balenciaga, fendi, givenchy, saint laurent, yves saint laurent, valentino, bottega veneta, celine, loewe, moncler,
canada goose, michael kors, kate spade, tory burch, coach bag, longchamp, rolex, omega watch, cartier, tiffany,
pandora, swarovski, ray-ban, rayban, oakley, maui jim, casio, g-shock, seiko, tag heuer, breitling, apple watch,
iphone, ipad, ipod, airpods, macbook, imac, apple pencil, magsafe, samsung, sony, playstation, ps5, ps4, xbox,
nintendo, nintendo switch, game boy, gameboy, microsoft, surface pro, google pixel, chromecast, bose, beats by dre,
jbl, sennheiser, skullcandy, sonos, anker, logitech, razer, corsair, steelseries, hyperx, dell, lenovo, thinkpad,
asus, acer, msi, canon, nikon, fujifilm, gopro, dji, fitbit, garmin, kindle, alexa, roku, nvidia, intel, amd, sandisk,
kingston, seagate, western digital, huawei, xiaomi, oneplus, motorola, nokia, otterbox, spigen, dyson, keurig,
nespresso, kitchenaid, cuisinart, instant pot, ninja foodi, vitamix, roomba, irobot, bissell, philips, braun, oral-b,
gillette, wahl, remington, conair, babyliss, ghd, revlon, panasonic, toshiba, hitachi, kenwood, jvc,
disney, pixar, mickey mouse, minnie mouse, winnie the pooh, frozen elsa, marvel, avengers, spider-man, spiderman,
iron man, captain america, hulk, black panther, deadpool, batman, superman, wonder woman, dc comics, justice league,
star wars, mandalorian, baby yoda, grogu, darth vader, harry potter, hogwarts, lord of the rings, game of thrones,
pokemon, pokémon, pikachu, mario, super mario, luigi, zelda, sonic the hedgehog, minecraft, fortnite, roblox,
among us, call of duty, hello kitty, sanrio, kuromi, snoopy, peanuts, spongebob, nickelodeon, sesame street,
peppa pig, paw patrol, bluey, cocomelon, my little pony, transformers, hot wheels, barbie, lego, hasbro, mattel, nerf,
play-doh, fisher-price, vtech, melissa & doug, squishmallow, squishmallows, funko, funko pop, labubu, crayola,
hallmark, stanley quencher, hydro flask, yeti, owala, tupperware, pyrex, rubbermaid, thermos, crock-pot, ziploc,
sharpie, post-it, duracell, energizer, velcro, teflon, gore-tex, kevlar, kleenex, band-aid, q-tips, yankee candle,
bath & body works, victoria's secret, sephora, maybelline, l'oreal, loreal, estee lauder, clinique, olay,
neutrogena, cerave, nivea, mac cosmetics, pampers, huggies, similac, enfamil, febreze, clorox, coca-cola, coca cola,
pepsi, starbucks, red bull, nutella, oreo, kit kat, hershey, lindt, m&m's, skittles, harley-davidson,
harley davidson, dewalt, milwaukee tool, makita, bosch, ryobi, craftsman, snap-on, leatherman, victorinox, zippo,
weber, traeger, coleman, fender, gibson, ibanez, yamaha, roland, shure, nfl, nba, mlb, nhl, ncaa, mls, ufc, wwe,
fifa, premier league, amazon, amazon basics
`;

function parseList(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** Every word to watch for, lowercase and de-duplicated (built-in list + VERO_EXTRA_WORDS). */
function getVeroWords() {
  return [...new Set([...parseList(CLAIM_WORDS), ...parseList(BRAND_WORDS), ...parseList(process.env.VERO_EXTRA_WORDS)])];
}

module.exports = { getVeroWords };
