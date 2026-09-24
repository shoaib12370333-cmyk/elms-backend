/**
 * SUGGESTIONS for Settings -> VeRO. Every user keeps their own VeRO word list (what they save there is what gets
 * flagged, warned about and removed); nothing on this list is flagged unless the user saves it.
 *
 * It is a large starter list of brand / character / trademark names that rights owners police through eBay's VeRO
 * programme, plus wording eBay bans (replica, counterfeit, ...). eBay does not publish a complete list, so a user can
 * type any word that is not here.
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

// Brands and IP by category (screening list supplied by the ELMS owner; overlaps with the list above are harmless).
const CATEGORY_WORDS = `
louis vuitton, lv, gucci, chanel, hermes, prada, dior, christian dior, versace, fendi, balenciaga, burberry, givenchy,
valentino, saint laurent, ysl, yves saint laurent, celine, bottega veneta, loewe, balmain, moncler, off-white, bvlgari,
bulgari, ferragamo, salvatore ferragamo, tom ford, alexander mcqueen, jimmy choo, christian louboutin, louboutin, miu miu,
goyard, coach, michael kors, mk, kate spade, tory burch, marc jacobs, longchamp, furla, mulberry,
rolex, omega, cartier, tiffany, tiffany & co, patek philippe, audemars piguet, tag heuer, breitling, hublot, iwc, panerai,
tudor, longines, tissot, swarovski, pandora, david yurman, van cleef, chopard, montblanc, mont blanc, fossil, michele,
citizen, seiko, casio, g-shock,
nike, air jordan, jordan, air max, adidas, yeezy, puma, reebok, under armour, new balance, asics, converse, vans, lululemon,
the north face, north face, patagonia, columbia, timberland, dr martens, doc martens, crocs, ugg, supreme, fila, champion,
skechers, brooks, salomon, hoka, on running, gymshark, stone island, carhartt,
apple, iphone, ipad, macbook, airpods, apple watch, imac, samsung, galaxy, sony, playstation, ps5, ps4, xbox, microsoft,
surface, nintendo, switch, bose, beats, jbl, sonos, sennheiser, marshall, dyson, gopro, dji, fitbit, garmin, anker,
logitech, razer, corsair, dell, alienware, hp, lenovo, asus, acer, nvidia, intel, amd, canon, nikon, fujifilm, ring, nest,
roku, tesla, oculus, meta quest, kindle, echo, alexa, google pixel, philips, braun,
disney, mickey mouse, minnie mouse, pixar, marvel, avengers, spider-man, spiderman, iron man, star wars, baby yoda, grogu,
mandalorian, dc comics, batman, superman, wonder woman, warner bros, harry potter, hogwarts, lord of the rings,
game of thrones, pokemon, pokémon, pikachu, mario, super mario, luigi, zelda, sonic, hello kitty, sanrio, spongebob,
nickelodeon, cartoon network, peppa pig, paw patrol, bluey, frozen, elsa, minions, despicable me, sesame street, barbie,
hot wheels, mattel, hasbro, transformers, my little pony, lego, funko, funko pop, squishmallows, bratz, anime, naruto,
dragon ball, one piece, studio ghibli,
nfl, nba, mlb, nhl, fifa, uefa, premier league, champions league, olympics, olympic, super bowl, world cup, formula 1, f1,
nascar, wwe, ufc, real madrid, barcelona, manchester united, liverpool fc, dallas cowboys, los angeles lakers,
new york yankees, topps, panini, fanatics,
mac, mac cosmetics, sephora, estee lauder, clinique, lancome, urban decay, too faced, benefit, nars, charlotte tilbury,
anastasia beverly hills, fenty, fenty beauty, kylie cosmetics, huda beauty, morphe, olaplex, kerastase, redken,
moroccanoil, dyson airwrap, ghd, foreo, la mer, sk-ii, drunk elephant, the ordinary, tatcha, cerave, dove, nivea,
l'oreal, maybelline,
audio-technica, shure, yamaha, fender, gibson, roland, korg, pioneer, denon, bang & olufsen, b&o, focal, kef,
kitchenaid, ninja, vitamix, nespresso, keurig, instant pot, le creuset, staub, all-clad, cuisinart, sodastream, irobot,
roomba, shark, dewalt, milwaukee, makita, bosch, snap-on, stanley, craftsman, ryobi, black+decker, weber, yeti,
stanley cup, owala, hydro flask, tupperware, pyrex, oxo,
ray-ban, rayban, oakley, persol, maui jim, costa del mar, warby parker, carrera,
ford, chevrolet, chevy, toyota, honda, bmw, mercedes, mercedes-benz, audi, volkswagen, vw, porsche, ferrari, lamborghini,
jeep, dodge, ram, cadillac, nissan, subaru, mazda, hyundai, kia, harley-davidson, harley davidson, brembo, bilstein, k&n,
nuna, uppababy, bugaboo, doona, stokke, baby bjorn, babybjorn, chicco, graco, fisher-price, melissa & doug, lego duplo
`;

// Claims from the same screening list that name what eBay bans.
const EXTRA_CLAIM_WORDS = `aaa quality, mirror quality, 1:1, dupe, knockoff, unauthorized, inspired by, replica`;

/** Words offered as suggestions while a user types in Settings -> VeRO. They are NOT flagged by themselves: only the words a user saves are. */
function getSuggestionWords() {
  return [...new Set([...parseList(CLAIM_WORDS), ...parseList(EXTRA_CLAIM_WORDS), ...parseList(BRAND_WORDS), ...parseList(CATEGORY_WORDS)])].sort();
}

module.exports = { getSuggestionWords };
