/*
 * ELMS extension: the maths and the checks, with no page or browser access, so they are tested on their own (tests/extensionLogic.test.js).
 *
 * The profit maths is the one of the ELMS Price Calculator: eBay takes its fees from what the buyer pays in total, not from what the
 * product cost you, so
 *     profit = price - cost - price x (fee% + promoted%) - fixed fee        and the price that leaves a wanted profit is
 *     price  = (cost + fixed fee + wanted profit) / (1 - fee% - promoted%)
 */
(function (root) {
  const DEFAULTS = Object.freeze({ feePct: 13, fixed: 0.3, adPct: 0, targetPct: 30 });
  const DAY = 86400000;

  const num = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const round2 = (n) => Math.round(n * 100) / 100;

  /** What the person saved in the popup -> numbers in a sensible range; anything missing is the default. */
  function normalizeSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const pick = (key, min, max) => {
      const has = r[key] !== undefined && r[key] !== null && r[key] !== '';
      const n = has ? parseFloat(String(r[key]).replace(',', '.')) : NaN;
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULTS[key];
    };
    return { feePct: pick('feePct', 0, 60), fixed: pick('fixed', 0, 100), adPct: pick('adPct', 0, 40), targetPct: pick('targetPct', 0, 500) };
  }

  /** What a sale at `price` leaves after eBay's fees, for a product that costs `cost`. */
  function evaluate(cost, price, s) {
    const c = num(cost);
    const p = num(price);
    const fvf = (p * s.feePct) / 100;
    const ad = (p * s.adPct) / 100;
    const fees = fvf + ad + s.fixed;
    const profit = p - c - fees;
    return { cost: c, price: p, fvf, ad, fixed: s.fixed, fees, profit, margin: p > 0 ? (profit / p) * 100 : 0, roi: c > 0 ? (profit / c) * 100 : 0 };
  }

  /** The price that leaves `targetPct` percent of the cost as profit; null when the fees eat everything. */
  function recommendedPrice(cost, s, targetPct) {
    const r = (s.feePct + s.adPct) / 100;
    if (1 - r <= 0) return null;
    const c = num(cost);
    return (c + s.fixed + (c * num(targetPct)) / 100) / (1 - r);
  }

  /** The lowest price that loses nothing. */
  function breakEvenPrice(cost, s) {
    const r = (s.feePct + s.adPct) / 100;
    return 1 - r <= 0 ? null : (num(cost) + s.fixed) / (1 - r);
  }

  /** The price the import will ask for at a markup (the same rounding as the server). */
  function priceAtMarkup(cost, markupPct) {
    const m = parseFloat(String(markupPct == null ? '' : markupPct).replace(',', '.'));
    const c = num(cost);
    return Number((c * (1 + (Number.isFinite(m) ? m : 0) / 100)).toFixed(2));
  }

  /** The smallest whole markup % whose price reaches `price`. */
  function markupToReach(cost, price) {
    const c = num(cost);
    return c > 0 && price != null ? Math.max(0, Math.ceil(((price / c) - 1) * 100 - 1e-9)) : null;
  }

  function formatMoney(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '-';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
    } catch (_) {
      return (currency ? currency + ' ' : '') + n.toFixed(2);
    }
  }

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

  /**
   * Days from today to the LAST date in an English delivery message ("FREE delivery Thursday, 12 - Monday, 16 March").
   * null when the text has no date this can read (other languages), so nothing is flagged then.
   */
  function parseDeliveryDays(text, now) {
    const t = String(text || '');
    if (!t) return null;
    const today = new Date(now instanceof Date ? now.getTime() : Number(now) || Date.now());
    today.setHours(0, 0, 0, 0);
    if (/\btoday\b/i.test(t)) return 0;
    const found = [];
    const add = (day, month, index) => {
      const d = Number(day);
      const m = MONTHS[String(month).slice(0, 3).toLowerCase()];
      if (d >= 1 && d <= 31 && m !== undefined) found.push({ d, m, index });
    };
    let m;
    const dayFirst = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH_RE + '\\b', 'gi');
    while ((m = dayFirst.exec(t))) add(m[1], m[2], m.index);
    const monthFirst = new RegExp('\\b' + MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b', 'gi');
    while ((m = monthFirst.exec(t))) add(m[2], m[1], m.index);
    if (!found.length) return /\btomorrow\b/i.test(t) ? 1 : null;
    found.sort((a, b) => a.index - b.index);
    const last = found[found.length - 1];
    let date = new Date(today.getFullYear(), last.m, last.d);
    if (date.getTime() < today.getTime() - 2 * DAY) date = new Date(today.getFullYear() + 1, last.m, last.d);
    return Math.round((date.getTime() - today.getTime()) / DAY);
  }

  const LEVEL_ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };
  const LIVE = new Set(['published', 'paused']);
  const WHERE = { draft: 'in your Drafts', published: 'live on eBay', paused: 'on eBay (paused)', publishing: 'being published', scheduled: 'scheduled to publish', error: 'in your Drafts with a publish error', ended: 'ended on eBay' };
  const plural = (n, one, many) => (n === 1 ? one : many);

  /**
   * The store the panel is working with, the listing this product already has in it, and its listings in other stores.
   * A listing with no store (made before stores existed) counts for whichever store asks.
   */
  function locate(server, storeId) {
    const stores = (server && server.stores) || [];
    const store = stores.find((s) => s.id === storeId) || stores.find((s) => s.isActive) || stores[0] || null;
    const rows = (server && server.existing) || [];
    const here = store ? rows.find((row) => (row.storeId || store.id) === store.id) || null : null;
    return { store, here, others: rows.filter((row) => row !== here) };
  }

  /** What an import costs, the way people read it: "Free" when the admin made it free, else "1 credit" / "5 credits". */
  function costLabel(n) {
    if (n == null || n === '') return ''; // not told (yet): no price, never "Free"
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '';
    return v === 0 ? 'Free' : v + (v === 1 ? ' credit' : ' credits');
  }

  /**
   * Everything worth knowing before an import, as a list of { id, level: 'bad'|'warn'|'info'|'ok', text }.
   * @param {{ page: object, server?: object|null, storeId?: string|null, settings: object, markup?: number|string|null, now?: Date }} input
   */
  function buildChecks({ page, server, storeId, settings, markup, now, market }) {
    const out = [];
    const add = (id, level, text) => out.push({ id, level, text });
    const cur = page.currency || 'USD';
    const money = (n, c) => formatMoney(n, c || cur);
    const cost = page.price;
    const { store, here, others } = locate(server, storeId);
    const stores = (server && server.stores) || [];
    const cannotImport = !!here && here.status !== 'draft'; // it is already on eBay (or on its way): the markup of a new import means nothing

    // ---- what the page itself says ----
    if (cost == null) add('price', 'bad', 'No price found on this page. Choose the colour / size first.');
    if (page.unavailable) add('stock', 'bad', 'Amazon says this product is unavailable right now.');
    else if (page.hasCart === false && cost != null) add('cart', 'warn', 'There is no "Add to Basket" button on this page, so the product may not be buyable.');

    if (cost != null && page.listPrice && page.listPrice >= cost * 1.25) add('deal', 'warn', 'On a deal (usual price ' + money(page.listPrice) + '). The price may go up when the deal ends.');
    else if (page.dealBadge && cost != null) add('deal', 'warn', 'On a limited-time deal. The price may go up when the deal ends.');

    if (page.soldBy) {
      if (page.amazonSold) add('seller', 'ok', 'Sold by Amazon.');
      else if (page.fulfilledByAmazon) add('seller', 'warn', 'Sold by ' + page.soldBy + ' (not Amazon), shipped by Amazon: its price can change when the seller changes it.');
      else add('seller', 'warn', 'Sold and shipped by ' + page.soldBy + ' (not Amazon): price, stock and delivery are up to that seller.');
    }

    const days = parseDeliveryDays(page.deliveryText, now);
    if (days !== null) {
      if (days > 21) add('delivery', 'bad', 'Delivery takes about ' + days + ' days. Buyers open late-delivery cases when it takes this long.');
      else if (days > 10) add('delivery', 'warn', 'Delivery takes about ' + days + ' days. That is slow for eBay buyers.');
      else add('delivery', 'ok', 'Delivery in about ' + days + ' ' + plural(days, 'day', 'days') + '.');
    }

    if (page.rating && page.ratingCount >= 10 && page.rating < 4) add('rating', 'warn', 'Rated ' + page.rating + ' / 5 by ' + Number(page.ratingCount).toLocaleString('en-US') + ' people. Low-rated products bring more returns.');
    else if (page.rating >= 4.3 && page.ratingCount >= 10) add('rating', 'ok', 'Rated ' + page.rating + ' / 5.');

    if (page.imageCount > 0 && page.imageCount < 3) add('images', 'warn', 'Only ' + page.imageCount + ' ' + plural(page.imageCount, 'picture', 'pictures') + '. Listings with few pictures sell less.');
    if (page.variantCount > 1) add('variants', 'info', page.variantCount + ' options (colour / size ...) will be imported as variants.');

    // ---- what the price leaves ----
    if (cost != null && settings && !cannotImport) {
      const sell = priceAtMarkup(cost, markup);
      const r = evaluate(cost, sell, settings);
      const m = markup === '' || markup == null ? 0 : Number(markup) || 0;
      if (r.profit < 0) add('profit', 'bad', 'At ' + m + '% markup you lose ' + money(-r.profit) + ' on every sale after eBay fees.');
      else if (r.margin < 10) add('profit', 'warn', 'Thin margin: you keep ' + money(r.profit) + ' (' + r.margin.toFixed(1) + '%) after eBay fees.');
    }

    // ---- what eBay shows (asked for when the panel is opened) ----
    if (market && market.available && !cannotImport) {
      if (market.count === 0) add('market', 'info', 'No similar listing found on eBay: a niche nobody sells in yet, or the search did not match this product.');
      else if (cost != null && settings && market.currency === cur) {
        const sell = priceAtMarkup(cost, markup);
        const even = breakEvenPrice(cost, settings);
        const lead = market.exact ? 'The' : 'Probably: the';
        if (even != null && even > market.median) add('market', market.exact ? 'bad' : 'warn', lead + ' typical eBay price (' + money(market.median) + ') is below your break-even price (' + money(even) + '), so this product cannot make money at market prices.');
        else if (sell > market.median * 1.15) add('market', 'warn', 'Your price ' + money(sell) + ' is ' + Math.round((sell / market.median - 1) * 100) + '% above the typical eBay price (' + money(market.median) + '): it may not sell.');
        else if (sell <= market.median) add('market', 'ok', 'Your price ' + money(sell) + ' is at or below the typical eBay price (' + money(market.median) + ').');
        if (market.total >= 100) add('crowded', 'info', 'Crowded: eBay has about ' + market.total + ' similar listings.');
      }
    }

    // ---- what ELMS knows ----
    if (server) {
      if (store && store.amazonOk === false) add('fit', 'bad', store.amazonMessage || 'This Amazon site does not match your store.');
      if (!stores.length) {
        // No store yet. When ELMS allows it the import still works (the draft is saved without a store; one is chosen when it is published):
        // a warning, not a stop. Otherwise the person is asked to connect one first.
        if (server.policy && server.policy.importWithoutStore) add('store', 'warn', 'No eBay store is connected yet. You can still import: the draft is saved without a store. Connect a store in ELMS before you publish it.');
        else add('store', 'bad', 'No eBay store is connected in ELMS yet. Connect one in ELMS first.');
      }

      const v = server.vero;
      if (v && v.terms && v.terms.length) {
        const where = Object.keys(v.fields || {}).map((f) => (f === 'bulletPoints' ? 'bullet points' : f)).join(', ');
        add('vero', 'bad', plural(v.terms.length, 'VeRO word', 'VeRO words') + ' found' + (where ? ' in the ' + where : '') + ': ' + v.terms.join(', ') + '. eBay can remove listings that use them.');
      }

      const credits = server.credits;
      if (credits && !credits.unlimited && credits.balance < credits.importCost) add('credits', 'bad', 'You do not have enough credits (' + credits.balance + ') for an import (' + credits.importCost + ').');

      if (here) {
        const label = store && store.label ? ' (' + store.label + ')' : '';
        if (here.status === 'draft') add('existing', 'warn', 'Already ' + WHERE.draft + label + '. Importing again refreshes it' + (server.credits && server.credits.importCost === 0 ? ' (free).' : ' and costs ' + costLabel(server.credits ? server.credits.importCost : 1) + '.'));
        else if (LIVE.has(here.status)) add('existing', 'bad', 'Already ' + WHERE[here.status] + label + (here.sellPrice ? ' at ' + money(here.sellPrice, here.currency) : '') + '. It cannot be imported again.');
        else add('existing', 'warn', 'Already ' + (WHERE[here.status] || here.status) + label + '. It cannot be imported again.');

        // A live listing: what has Amazon's price done since it was listed?
        if (LIVE.has(here.status) && here.amazonPrice && here.sellPrice && cost != null && (!here.currency || here.currency === cur) && settings) {
          const change = (cost - here.amazonPrice) / here.amazonPrice;
          const now2 = evaluate(cost, here.sellPrice, settings);
          if (Math.abs(change) >= 0.03) {
            const head = 'Amazon is now ' + money(cost) + ' (' + money(here.amazonPrice) + ' when you listed). ';
            if (now2.profit < 0) add('livePrice', 'bad', head + 'At your eBay price of ' + money(here.sellPrice) + ' you now LOSE ' + money(-now2.profit) + ' per sale.');
            else if (change > 0) add('livePrice', 'warn', head + 'At your eBay price you keep ' + money(now2.profit) + ' (' + now2.margin.toFixed(1) + '%).');
            else add('livePrice', 'info', head + 'You keep more now: ' + money(now2.profit) + ' (' + now2.margin.toFixed(1) + '%).');
          } else add('livePrice', 'ok', 'Amazon price unchanged since you listed (' + money(here.amazonPrice) + ').');
        }
      }
      if (others.length) add('otherStores', 'info', 'Also in your other ' + plural(others.length, 'store', 'stores') + ': ' + others.map((o) => (o.storeLabel || 'a store') + ' (' + (WHERE[o.status] || o.status) + ')').join(', ') + '.');
    }

    return out.map((c, i) => ({ c, i })).sort((a, b) => LEVEL_ORDER[a.c.level] - LEVEL_ORDER[b.c.level] || a.i - b.i).map((x) => x.c);
  }

  /** The worst level in a list of checks: 'bad' | 'warn' | 'ok'. */
  function worstLevel(checks) {
    if (checks.some((c) => c.level === 'bad')) return 'bad';
    if (checks.some((c) => c.level === 'warn')) return 'warn';
    return 'ok';
  }

  const api = { DEFAULTS, WHERE, LIVE, locate, normalizeSettings, evaluate, recommendedPrice, breakEvenPrice, priceAtMarkup, markupToReach, formatMoney, parseDeliveryDays, costLabel, buildChecks, worstLevel, round2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ELMS_LOGIC = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
