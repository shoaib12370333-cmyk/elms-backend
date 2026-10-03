/**
 * Placing the AliExpress order for an eBay order line (a dropshipper's "buy it from the supplier"), and following it.
 *
 * Real money moves here, so the design is deliberately slow and explicit - three separate, confirmed steps, none of them automatic:
 *   1. previewOrder   read-only. What would be ordered (product, option, quantity), the delivery method and its cost, the buyer's
 *                     address (editable), the total, and whether it would lose money. Blockers say why an order may not be placed.
 *   2. placeOrder     creates the order at AliExpress UNPAID (payment.try_to_pay = false). The server re-runs the preview itself - it never
 *                     trusts numbers from the browser - and takes an atomic claim first, so two clicks can never place it twice.
 *   3. payOrder       pays it, only for the exact amount AliExpress reports and the seller saw (a changed amount stops it).
 * refreshOrder reads the order's status and shipment back from AliExpress (also run by jobs/aliexpressOrderSync.js); it never ships
 * anything to eBay - sending the tracking number stays the seller's click (the existing PUT /api/orders/:id/tracking).
 *
 * API shapes: services/aliexpressAdapter.js (from AliExpress's own API reference pages). NOT yet run against a real account.
 */
const { skuStock, skuPrice, skuAttrForOrder, skuAttrIsClear, skuAttrNames } = require('./aliexpressSkuHelpers');

// International dial codes of the countries ELMS' eBay marketplaces sell to (and a few neighbours): used to split a phone number
// into the country part and the rest, which is what AliExpress's address wants (phone_country + mobile_no).
const COUNTRY_DIAL = {
  US: '1', CA: '1', GB: '44', UK: '44', IE: '353', DE: '49', AT: '43', CH: '41', FR: '33', BE: '32', NL: '31', LU: '352', IT: '39', ES: '34', PT: '351',
  PL: '48', SE: '46', NO: '47', DK: '45', FI: '358', AU: '61', NZ: '64', SG: '65', MY: '60', HK: '852', PH: '63', TW: '886', JP: '81', IN: '91', MX: '52', BR: '55',
};
const DIAL_CODES_LONGEST_FIRST = [...new Set(Object.values(COUNTRY_DIAL))].sort((a, b) => b.length - a.length);

/** A phone number as AliExpress wants it: { phoneCountry: '+44' | null, mobileNo: '7700900123' }. A number with a "+" (or "00") is split by its dial code; a national number takes the destination country's. */
function splitPhone(phone, country) {
  // "(0)" in "+44 (0)7700 900123" is the trunk digit people write for readers inside the country: it is not dialled from abroad. An
  // extension ("ext 12", "x12") is not part of the number either.
  const text = String(phone || '').replace(/\(\s*0\s*\)/g, '').replace(/\s*(?:ext\.?|extension|x)\s*\d+\s*$/i, '');
  let raw = text.replace(/[^\d+]/g, '');
  if (raw.startsWith('00')) raw = '+' + raw.slice(2);
  if (raw.startsWith('+')) {
    const body = raw.replace(/\D/g, '');
    const code = DIAL_CODES_LONGEST_FIRST.find((c) => body.startsWith(c));
    return code ? { phoneCountry: '+' + code, mobileNo: body.slice(code.length) } : { phoneCountry: null, mobileNo: body };
  }
  let national = raw.replace(/\D/g, '');
  const iso = String(country || '').toUpperCase();
  const code = COUNTRY_DIAL[iso];
  // A national number that already starts with the country's own code ("1 415 555 2671" for the US/Canada, "447700 900123" for the UK) is a
  // full number written without the "+": the code is taken off once, not sent twice. Only where that cannot be a real national number
  // (a US number is 10 digits, a UK one 10 after its 0); elsewhere the digits are left exactly as typed ("55" in Brazil is an area code).
  if ((code === '1' && national.length === 11 && national.startsWith('1')) || (code === '44' && national.length >= 12 && national.startsWith('44'))) national = national.slice(code.length);
  // The trunk 0 of a national number is not dialled from abroad - except in Italy, where the 0 of a landline is part of the number.
  return { phoneCountry: code ? '+' + code : null, mobileNo: iso === 'IT' ? national : national.replace(/^0+/, '') };
}

const ADDRESS_FIELDS = ['fullName', 'line1', 'line2', 'city', 'state', 'zip', 'country', 'phone'];
const REQUIRED_ADDRESS = [['fullName', "the buyer's name"], ['line1', 'the street address'], ['city', 'the city'], ['zip', 'the postcode'], ['country', 'the country'], ['phone', 'a phone number']];

/** The delivery address of an order line as the seller can edit it. `override` (from the browser) wins field by field. */
function addressOf(order, override) {
  const a = (order && order.shipping_address) || {};
  const base = {
    fullName: a.fullName || '', line1: a.addressLine1 || '', line2: a.addressLine2 || '', city: a.city || '',
    state: a.stateOrProvince || '', zip: a.postalCode || '', country: a.country || '', phone: (order && order.buyer_phone) || '',
  };
  const o = override && typeof override === 'object' ? override : {};
  const out = {};
  for (const key of ADDRESS_FIELDS) out[key] = String(o[key] !== undefined && o[key] !== null ? o[key] : base[key]).replace(/\s+/g, ' ').trim().slice(0, 200);
  out.country = out.country.toUpperCase();
  return out;
}

/** The address object aliexpress.ds.order.create calls logistics_address. */
function toLogisticsAddress(addr) {
  const { phoneCountry, mobileNo } = splitPhone(addr.phone, addr.country);
  return {
    contact_person: addr.fullName,
    full_name: addr.fullName,
    address: addr.line1,
    ...(addr.line2 ? { address2: addr.line2 } : {}),
    city: addr.city,
    province: addr.state || addr.city,
    zip: addr.zip,
    country: addr.country,
    mobile_no: mobileNo,
    ...(phoneCountry ? { phone_country: phoneCountry } : {}),
    locale: 'en_US',
  };
}

/**
 * The number ELMS sends as out_order_id: all digits (AliExpress's own example is numeric), stable per order line, so a retry after an unclear
 * answer sends the same one (if AliExpress de-duplicates on it, that is wanted). After an AliExpress order was CONFIRMED dead (closed unpaid,
 * or released by the seller) a new order is a new purchase: its number ends in the last two digits of the dead order's number, so AliExpress
 * does not mistake it for a repeat.
 */
function outOrderIdFor(orderId, retiredAeOrderId) {
  const hex = String(orderId || '').replace(/[^a-f0-9]/gi, '');
  if (!hex) return null;
  const base = BigInt('0x' + hex).toString().slice(-18);
  const tail = String(retiredAeOrderId || '').replace(/\D/g, '').slice(-2).padStart(2, '0');
  return retiredAeOrderId ? base.slice(0, base.length - 2) + tail : base;
}

// What the seller is told for each refusal AliExpress documents for aliexpress.ds.order.create.
const FRIENDLY_ERRORS = {
  B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL: 'AliExpress says the delivery address is wrong. Check the name, street, city, postcode, country and phone number, correct them below and try again.',
  B_DROPSHIPPER_DELIVERY_ADDRESS_CPF_CN_INVALID: 'AliExpress says the tax/ID number of the address is wrong.',
  B_DROPSHIPPER_DELIVERY_ADDRESS_CPF_NOT_MATCH: 'AliExpress says the tax/ID number of the address does not match.',
  BLACKLIST_BUYER_IN_LIST: 'AliExpress will not let this AliExpress account place orders. Contact AliExpress.',
  USER_ACCOUNT_DISABLED: 'This AliExpress account is disabled, so it cannot place orders. Contact AliExpress.',
  PRICE_PAY_CURRENCY_ERROR: 'AliExpress rejected the payment currency of this order.',
  DELIVERY_METHOD_NOT_EXIST: 'AliExpress does not offer that delivery method any more. Press "Check again" and try once more.',
  INVENTORY_HOLD_ERROR: 'AliExpress does not have enough stock for this order right now.',
  REPEATED_ORDER_ERROR: 'AliExpress says this order looks like one that was already placed. Check your AliExpress orders before trying again.',
};
const UNEXPLAINED_CODES = new Set(['ERROR_WHEN_BUILD_FOR_PLACE_ORDER', 'A001_ORDER_CANNOT_BE_PLACED', 'A002_INVALID_ZONE', 'A003_SUSPICIOUS_BUYER', 'A004_CANNOT_USER_COUPON', 'A005_INVALID_COUNTRIES', 'A006_INVALID_ACCOUNT_INFO']);

/** A refusal from AliExpress -> what the seller reads, and the state to keep: 'failed' (nothing was placed) or 'unknown' (an order may exist). */
function explainError(err) {
  const code = err && err.aliCode ? String(err.aliCode) : null;
  const message = (code && FRIENDLY_ERRORS[code])
    || (code && UNEXPLAINED_CODES.has(code) ? `AliExpress could not place this order (${code}). Contact AliExpress support.` : null)
    || (err && err.message) || 'AliExpress did not place the order.';
  // REPEATED_ORDER_ERROR means AliExpress already has an order that looks the same: it MAY exist, so it must be looked at, not retried.
  const state = err && err.rejected === true && code !== 'REPEATED_ORDER_ERROR' ? 'failed' : 'unknown';
  return { message, code, state };
}

const money = (n) => Number(Number(n).toFixed(2));
// order_status is what the seller SEES on eBay (derived from eBay's own fields too); fulfillment_status is only what ELMS recorded.
const isShipped = (order) => ['shipped', 'delivered'].includes(order.fulfillment_status) || ['shipped', 'delivered'].includes(order.order_status);
const isCancelled = (order) => order.order_status === 'cancelled' || /^(CANCELED|CANCELLED|CANCEL_REQUESTED|IN_PROGRESS)$/i.test(String(order.ebay_cancel_status || ''));
const isUnpaidOnEbay = (order) => order.order_status === 'awaiting_payment' || !!(order.ebay_payment_status && order.ebay_payment_status !== 'PAID');
/** The order already carries a mark of "bought from the supplier" (ELMS' Mark as ordered, or an order number typed in): a new AliExpress order may buy it twice. */
const isMarkedOrdered = (order) => order.fulfillment_status === 'ordered_from_amazon' || !!order.ordered_at || !!order.amazon_order_id;

// Which switch the seller flips to accept an overridable blocker, by blocker code. allowLoss = "I know the money side is not clear or
// not good"; confirmNotPlaced = "I checked AliExpress and it is not already bought".
const OVERRIDE_FLAG = { loses_money: 'allowLoss', sale_unknown: 'allowLoss', currency_unknown: 'allowLoss', unknown_state: 'confirmNotPlaced', already_ordered: 'confirmNotPlaced' };

// Replaceable for tests.
const deps = {
  getOrder: (userId, id) => require('../models/ordersModel').getOrderById(userId, id),
  getListing: (userId, id) => require('../models/listingsModel').getListingById(userId, id),
  claim: (userId, id, opts) => require('../models/ordersModel').claimAliexpressOrder(userId, id, opts),
  claimPayment: (userId, id) => require('../models/ordersModel').claimAliexpressPayment(userId, id),
  releasePayment: (userId, id) => require('../models/ordersModel').releaseAliexpressPayment(userId, id),
  update: (userId, id, patch, guard) => require('../models/ordersModel').updateAliexpressOrder(userId, id, patch, guard),
  adapter: () => require('./aliexpressAdapter'),
  convert: (amount, from, to) => require('./currencyService').convertAmount(amount, from, to),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A write that MUST land (the order exists at AliExpress, or money was sent): tried up to 3 times, with a pause, before giving up. */
async function saveWithRetry(d, userId, orderId, patch) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await d.update(userId, orderId, patch); } catch (err) { lastError = err; if (attempt < 2) await d.sleep(150 * (attempt + 1)); }
  }
  throw lastError;
}

// AliExpress order_status words (from its API reference; NOT yet seen on a real account). Payment is only sent for an order that is waiting
// for it (fail closed: an unknown word is "not payable", never "go ahead"), and an order counts as paid when AliExpress shows a payment time
// or a status that can only be reached after paying.
const AWAITING_PAYMENT_STATUS = /^(PLACE_ORDER_SUCCESS|WAIT_BUYER_PAY|WAIT_PAY|UNPAID)$/i;
const PAID_STATUS = /^(FUND_PROCESSING|WAIT_SELLER_SEND_GOODS|SELLER_PART_SEND_GOODS|WAIT_BUYER_ACCEPT_GOODS|WAIT_SELLER_EXAMINE_MONEY|RISK_CONTROL|IN_ISSUE|IN_FROZEN)$/i;
// A payment request that got no clear answer blocks a second one for this long (models/ordersModel.js claimAliexpressPayment); one that has
// been "in flight" much longer, on an order AliExpress has since closed, was evidently never paid (refreshOrder frees the line).
const PAYING_STALE_MS = 15 * 60 * 1000;
const PAYING_ABANDONED_MS = 30 * 60 * 1000;
const hasPaymentEvidence = (detail) => !!(detail && (detail.paidAt || PAID_STATUS.test(String(detail.status || ''))));
const isAwaitingPayment = (detail) => !!(detail && AWAITING_PAYMENT_STATUS.test(String(detail.status || '')));

/**
 * Step 1 - read-only. Everything the seller needs to decide, and every reason the order may not be placed (`blockers`; `overridable`
 * ones - the order would lose money, or an earlier try left an unclear result - can be accepted explicitly when placing).
 * @returns {Promise<{ error: 'not_found' } | { orderId, state, blockers, warnings, canPlace, item, shipping, cost, sale, margin, address, existing }>}
 */
async function previewOrder(userId, orderId, { address: addressOverride } = {}, d = deps) {
  const order = await d.getOrder(userId, orderId);
  if (!order) return { error: 'not_found' };
  const blockers = [];
  const warnings = [];
  // A blocker the seller may accept on purpose says which switch accepts it (`override`: 'allowLoss' | 'confirmNotPlaced'); the rest cannot be accepted.
  const block = (code, message, extra = {}) => blockers.push({ code, message, ...(OVERRIDE_FLAG[code] ? { overridable: true, override: OVERRIDE_FLAG[code] } : {}), ...extra });
  const warn = (code, message) => warnings.push({ code, message });
  const existing = order.aliexpress_order || null;
  const address = addressOf(order, addressOverride);
  const quantity = Math.max(1, Math.trunc(Number(order.quantity) || 1));

  if (isShipped(order)) block('shipped', 'This order is already shipped.');
  if (isCancelled(order)) block('cancelled', 'This order was cancelled or has a cancellation in progress on eBay.');
  if (isUnpaidOnEbay(order)) block('not_paid', `eBay shows this order as "${order.ebay_payment_status || 'awaiting payment'}", not paid - do not buy it yet.`);
  if (isMarkedOrdered(order)) block('already_ordered', 'This order is already marked as ordered (in ELMS, or with an order number). Placing an AliExpress order as well may buy it twice - do that only if the earlier mark was a mistake.');
  if (existing && existing.state === 'placed') block('already_placed', `An AliExpress order (${existing.ae_order_id || 'number pending'}) was already placed for this order.`);
  else if (existing && existing.state === 'placing') block('in_flight', 'The AliExpress order for this line is being placed right now.');
  else if (existing && existing.state === 'unknown') block('unknown_state', existing.error || 'The last try did not get a clear answer from AliExpress: an order MAY exist. Open your AliExpress orders and check before trying again.');

  const listing = order.listing_id ? await d.getListing(userId, order.listing_id) : null;
  const aliexpressListing = !!(listing && listing.source_platform === 'aliexpress' && listing.aliexpress_product_id && listing.aliexpress_sku_id);
  if (!aliexpressListing) block('not_aliexpress', 'This order is not for a product imported from AliExpress.');

  for (const [key, label] of REQUIRED_ADDRESS) if (!address[key]) block('address_' + key, `The delivery address has no ${label}.`);
  if (address.phone) {
    const digits = splitPhone(address.phone, address.country).mobileNo.length;
    if (digits < 5 || digits > 15) block('address_phone', `The phone number "${address.phone}" does not look right (AliExpress wants 5 to 15 digits without the country code). Correct it below.`);
  }

  const result = { orderId: String(orderId), state: existing ? existing.state : null, existing, address, item: null, shipping: null, cost: null, sale: null, margin: null };

  // AliExpress is asked only for an order that could still be placed: nothing to look up for one that is shipped, cancelled, unpaid or already placed.
  const hardStop = blockers.some((b) => ['shipped', 'cancelled', 'not_paid', 'already_placed', 'in_flight', 'not_aliexpress'].includes(b.code));
  if (!hardStop) {
    const adapter = d.adapter();
    const costCurrency = String(listing.currency || 'USD').toUpperCase();
    let detail = null;
    try {
      detail = await adapter.getProductDetail(userId, { productId: listing.aliexpress_product_id, shipToCountry: address.country || 'US', targetCurrency: costCurrency });
    } catch (err) {
      if (err && err.productMissing) block('product_gone', 'AliExpress no longer has this product.');
      else block('aliexpress_error', `Could not read the product from AliExpress: ${err && err.message ? err.message : 'no answer'}`);
    }
    if (detail) {
      const skus = Array.isArray(detail.ae_item_sku_info_dtos) ? detail.ae_item_sku_info_dtos : [];
      const wanted = String(listing.aliexpress_sku_id);
      const matches = skus.filter((s) => String(s.sku_id) === wanted);
      // A listing imported before AliExpress ids were read exactly may hold a sku id that was ROUNDED (a 17-digit id loses its last digit as a plain
      // JSON number). If another option's real id rounds to the saved one, the saved id could mean either of them: never guess which.
      // Only a listing from an older import can hold a rounded id: one imported since then says so (aliexpress_ids_exact) and is trusted as it is.
      const roundedTwins = listing.aliexpress_ids_exact ? [] : skus.filter((s) => String(s.sku_id) !== wanted && String(Number(s.sku_id)) === wanted);
      const sku = matches.length === 1 && !roundedTwins.length ? matches[0] : null;
      if (!sku) {
        block('sku_missing', roundedTwins.length
          ? 'The option number saved with this listing may have been rounded (it was imported before ELMS read AliExpress ids exactly) and could mean a different option. Delete this listing and import the product again.'
          : matches.length > 1 ? 'AliExpress lists more than one option with this number, so the right one cannot be told apart.' : 'AliExpress no longer lists the option this listing was made from.');
      } else {
        const unit = skuPrice(sku);
        const stock = skuStock(sku);
        const currency = String(sku.currency_code || detail.ae_item_base_info_dto?.currency_code || costCurrency).toUpperCase();
        if (stock !== null && stock < quantity) block('out_of_stock', `AliExpress has ${stock} in stock, the order needs ${quantity}.`);
        else if (stock === null) warn('stock_unknown', 'AliExpress did not say how many are in stock.');
        if (unit === null) block('no_price', 'AliExpress gave no price for this option.');
        // The order names the option only by sku_attr. If a part of it cannot be sent (or a product with several options has none), AliExpress
        // would fill in some other option - the buyer would get the wrong item - so such an option is never ordered automatically.
        const skuAttr = skuAttrForOrder(sku.sku_attr);
        const hasOptions = skus.length > 1 || (Array.isArray(sku.ae_sku_property_dtos) && sku.ae_sku_property_dtos.length > 0);
        // ...and two options of the product that would be sent as the SAME string cannot be told apart either.
        const sameAttr = skuAttr ? skus.filter((s) => s !== sku && skuAttrForOrder(s.sku_attr) === skuAttr) : [];
        if (!skuAttrIsClear(sku.sku_attr) || (hasOptions && !skuAttr) || sameAttr.length) {
          block('sku_attr_unclear', "ELMS cannot tell AliExpress exactly which option (colour, size...) to order, so it could send the wrong one. Order this one on AliExpress yourself.");
        }
        const title = detail.ae_item_base_info_dto?.subject || listing.title || null;
        result.item = { productId: String(listing.aliexpress_product_id), skuId: String(listing.aliexpress_sku_id), skuAttr, optionNames: skuAttrNames(sku.sku_attr), title, quantity, unitPrice: unit, currency, stock };

        let quote = null;
        if (address.country) quote = await adapter.quoteShipping(userId, { productId: listing.aliexpress_product_id, skuId: listing.aliexpress_sku_id, shipToCountry: address.country, currency, quantity });
        if (address.country && !quote) block('no_shipping', `AliExpress has no delivery method to ${address.country} for this option.`);
        // logistics_service_name is required by aliexpress.ds.order.create and is the delivery option's code: an option without one cannot be ordered.
        if (quote && !quote.code) block('no_shipping', 'AliExpress did not name the delivery method, so it cannot be ordered.');
        if (quote) result.shipping = quote;

        if (unit !== null && quote) {
          const items = money(unit * quantity);
          result.cost = { items, shipping: money(quote.cost), total: money(items + quote.cost), currency };
          const revenue = money(Number(order.sale_price || 0) + Number(order.delivery_cost || 0));
          const saleCurrency = String(order.currency || '').toUpperCase();
          result.sale = { amount: revenue, currency: saleCurrency || null };
          // Not being able to check the money side is a blocker the seller can accept on purpose (allowLoss) - it is never silently waved through.
          if (!(revenue > 0)) {
            block('sale_unknown', "ELMS does not know what the buyer paid for this line, so it cannot tell if the order would make money.");
          } else if (!saleCurrency) {
            block('currency_unknown', "ELMS does not know which currency the buyer paid in, so it cannot tell if the order would make money.");
          } else {
            let costInSale = result.cost.total;
            try { costInSale = currency === saleCurrency ? result.cost.total : money((await d.convert(result.cost.total, currency, saleCurrency)).amount); }
            catch (_) { costInSale = null; block('currency_unknown', `No exchange rate is available between ${currency} and ${saleCurrency}, so the profit could not be checked.`); }
            if (costInSale !== null) {
              result.margin = { amount: money(revenue - costInSale), currency: saleCurrency, costInSaleCurrency: costInSale };
              if (revenue - costInSale < 0) block('loses_money', `The order would cost ${costInSale.toFixed(2)} ${saleCurrency} and the buyer paid ${revenue.toFixed(2)} ${saleCurrency} (before eBay's fees): a loss of ${(costInSale - revenue).toFixed(2)}.`);
              else if (revenue - costInSale < revenue * 0.15) warn('thin_margin', `Only ${(revenue - costInSale).toFixed(2)} ${saleCurrency} is left before eBay's fees (usually about 13% of the sale).`);
            }
          }
        }
      }
    }
  }

  result.blockers = blockers;
  result.warnings = warnings;
  result.canPlace = blockers.length === 0;
  return result;
}

/**
 * Step 2 - places the order at AliExpress, UNPAID. Re-runs the preview here (the browser's numbers are never trusted), takes the atomic
 * claim, then calls AliExpress once. Answers { order } or { error, message, ... }:
 *   blocked   the preview has blockers the seller has not accepted (allowLoss: loses_money / sale_unknown / currency_unknown;
 *             confirmNotPlaced: unknown_state / already_ordered - see OVERRIDE_FLAG)
 *   claimed   another click / tab got there first, or it is already placed
 *   refused   AliExpress refused (nothing was placed - fix the cause and try again)
 *   unknown   no clear answer (an order MAY exist - the seller must check AliExpress before trying again)
 */
async function placeOrder(userId, orderId, { address, allowLoss = false, confirmNotPlaced = false, shownCodes } = {}, d = deps) {
  const preview = await previewOrder(userId, orderId, { address }, d);
  if (preview.error) return preview;
  // The seller's consent is for the blockers they were SHOWN and ticked (shownCodes), not for whatever the order has become since: a blocker
  // that appeared after the window was drawn (another tab placed the order meanwhile and it came back unclear) is not covered by the old tick.
  const accepted = { allowLoss: allowLoss === true, confirmNotPlaced: confirmNotPlaced === true };
  const shown = Array.isArray(shownCodes) ? shownCodes.map(String) : [];
  const stopping = preview.blockers.filter((b) => !(b.overridable && accepted[b.override] === true && shown.includes(b.code)));
  if (stopping.length) return { error: 'blocked', message: stopping[0].message, blockers: stopping, preview };
  if (!preview.item || !preview.shipping || !preview.cost) return { error: 'blocked', message: 'The order could not be worked out. Press "Check again".', blockers: [], preview };

  // An unclear earlier try may be claimed again only if the preview just saw it (and, above, the seller ticked that very blocker).
  const retryUnknown = preview.blockers.some((b) => b.code === 'unknown_state');
  const claimed = await d.claim(userId, orderId, { retryUnknown });
  if (!claimed) return { error: 'claimed', message: 'This order is already placed, or is being placed right now.', preview };

  // After an AliExpress order was CONFIRMED dead (closed unpaid / released) the new order gets its own out_order_id; a retry after an unclear answer keeps the same one.
  const previous = preview.existing;
  const outOrderId = outOrderIdFor(orderId, previous && ['CLOSED_UNPAID', 'RELEASED'].includes(previous.error_code) ? previous.ae_order_id : null);
  let created;
  try {
    created = await d.adapter().createOrder(userId, {
      items: [{ productId: preview.item.productId, skuAttr: preview.item.skuAttr, quantity: preview.item.quantity, logisticsServiceName: preview.shipping.code }],
      address: toLogisticsAddress(preview.address),
      outOrderId,
      payCurrency: preview.cost.currency,
    });
  } catch (err) {
    const why = explainError(err);
    try { await saveWithRetry(d, userId, orderId, { state: why.state, error: why.message, errorCode: why.code, outOrderId }); } catch (saveErr) {
      console.error(`[aliexpress-order] answer for order ${orderId} (user ${userId}) could not be saved: ${saveErr.message} - AliExpress said: ${why.message}`);
      throw Object.assign(new Error('ELMS could not save the answer from AliExpress. An order MAY have been placed - check your AliExpress orders before trying again.'), { irreversible: true });
    }
    return { error: why.state === 'failed' ? 'refused' : 'unknown', message: why.message, code: why.code, preview };
  }
  // The order exists at AliExpress from here on: its numbers go in the log BEFORE the database is touched, so they are never lost even if saving fails.
  console.log(`[aliexpress-order] placed AliExpress order ${created.orderIds.join(',')} for order ${orderId} (user ${userId}, out_order_id ${outOrderId})`);
  let order;
  try {
    order = await saveWithRetry(d, userId, orderId, {
      state: 'placed', aeOrderId: created.orderIds[0], aeOrderIds: created.orderIds, outOrderId, placedAt: d.now(),
      payState: 'unpaid', estimatedCost: preview.cost.total, currency: preview.cost.currency, shippingService: preview.shipping.code,
      error: null, errorCode: null, finished: false,
      // nothing of an earlier (dead) AliExpress order is left on the line: its status, amount, parcel and payment marks would describe the wrong order
      status: null, logisticsStatus: null, amount: null, paidAt: null, payingAt: null, trackingNumber: null, carrier: null, etaAt: null, lastEvent: null, syncedAt: null,
    });
  } catch (err) {
    console.error(`[aliexpress-order] AliExpress order ${created.orderIds.join(',')} EXISTS for order ${orderId} (user ${userId}) but could not be saved: ${err.message}`);
    throw Object.assign(new Error(`The AliExpress order ${created.orderIds.join(', ')} WAS created, but ELMS could not save it. Do not order again - find it in your AliExpress orders.`), { irreversible: true });
  }
  return { order, preview };
}

/** AliExpress's order status -> whether ELMS can stop asking about it (finished or closed). The raw status is always kept and shown as it is. */
function isFinishedStatus(status) {
  return /^(FINISH|FINISHED|COMPLETED|CLOSED|CANCEL|CANCELED|CANCELLED)/i.test(String(status || ''));
}

/** The distinct AliExpress order numbers saved for a line (ELMS follows ONE per line; AliExpress may have split it into several). */
const aeOrderIdsOf = (ae) => [...new Set([ae.ae_order_id, ...(Array.isArray(ae.ae_order_ids) ? ae.ae_order_ids : [])].filter(Boolean).map(String))];

/**
 * Reads the order back from AliExpress and saves status, total, payment and the shipment (tracking number + carrier) on the order line.
 * Never sends anything to eBay or the buyer. Every write is CONDITIONAL on the line still holding the same placed order, so a slow
 * refresh (the job and a click at once) can never overwrite what happened in between.
 * @returns {Promise<{ order } | { error: 'not_found'|'not_placed'|'changed', message? }>}
 */
async function refreshOrder(userId, orderId, d = deps) {
  const order = await d.getOrder(userId, orderId);
  if (!order) return { error: 'not_found' };
  const ae = order.aliexpress_order;
  if (!ae || ae.state !== 'placed' || !ae.ae_order_id) return { error: 'not_placed', message: 'No AliExpress order was placed for this line.' };
  const adapter = d.adapter();
  const detail = await adapter.getOrderDetail(userId, ae.ae_order_id);
  if (!detail) return { error: 'not_placed', message: 'AliExpress sent back nothing for this order.' };
  const guard = { state: 'placed', aeOrderId: ae.ae_order_id };
  const changed = { error: 'changed', message: 'This order changed while it was being read. Press "Refresh" again.' };

  // Split into several AliExpress orders: only the first is read here, so nothing about the whole (paid, closed, finished) can be concluded.
  if (aeOrderIdsOf(ae).length > 1) {
    const saved = await d.update(userId, orderId, { syncedAt: d.now(), finished: false }, guard);
    return saved ? { order: saved, detail, multiple: true } : changed;
  }

  const evidence = hasPaymentEvidence(detail);
  // An order that was CLOSED / CANCELLED before it was ever paid bought nothing: it goes back to "not placed" so it can be placed again
  // (otherwise the line would stay "placed" forever and could never be re-ordered). Only when neither ELMS nor AliExpress shows a payment -
  // and the write itself fails if a payment started in the meantime.
  // "Closed" must also mean "no parcel ever existed" (a delivered order ends as FINISH too, and a FINISHed order whose payment ELMS never
  // recorded must not be mistaken for an unpaid one), and a FINISHed order only counts when every line ended for a cancel / timeout kind of
  // reason, not a confirmed delivery.
  const noShipment = detail.logistics.length === 0 && !detail.logisticsStatus && !ae.tracking_number;
  const closedStatus = /^(CLOSED|CANCEL)/i.test(String(detail.status || ''));
  const finishedUnpaid = /^FINISH/i.test(String(detail.status || '')) && detail.lines.length > 0
    && detail.lines.every((l) => l.endReason && !/confirm|receiv|complet|finish|deliver|success/i.test(String(l.endReason)));
  // A payment request that has been "in flight" for far too long, on an order AliExpress has since closed, was never paid: the line is freed too.
  const payingAbandoned = ae.pay_state === 'paying' && !!ae.paying_at && d.now().getTime() - new Date(ae.paying_at).getTime() > PAYING_ABANDONED_MS;
  if (!evidence && ae.pay_state !== 'paid' && (ae.pay_state !== 'paying' || payingAbandoned) && noShipment && (closedStatus || finishedUnpaid)) {
    const reset = await d.update(userId, orderId, {
      state: 'failed', payState: 'unpaid', status: detail.status, logisticsStatus: detail.logisticsStatus, syncedAt: d.now(), finished: true,
      error: `The AliExpress order ${ae.ae_order_id} was closed without being paid, so nothing was bought. You can place it again.`, errorCode: 'CLOSED_UNPAID',
    }, { ...guard, payStateNotIn: payingAbandoned ? ['paid'] : ['paid', 'paying'] });
    return reset ? { order: reset, detail, reset: true } : changed;
  }
  // The shipment is asked for once the order is PAID (or AliExpress already lists a parcel): an unpaid order cannot have shipped. It is NOT
  // guessed from the status words - "WAIT_SELLER_SEND_GOODS" contains "SEND" and means the opposite. No shipment yet comes back as [].
  // Only the carrier's own number from the tracking lookup is ever saved: the number inside the order detail may be AliExpress's internal one,
  // and a number saved here can be sent to the buyer.
  let shipments = [];
  if (evidence || ae.pay_state === 'paid' || detail.logistics.length > 0) shipments = await adapter.getOrderTracking(userId, ae.ae_order_id).catch(() => []);
  const first = shipments[0] || null;
  const patch = {
    status: detail.status, logisticsStatus: detail.logisticsStatus, syncedAt: d.now(),
    finished: isFinishedStatus(detail.status),
  };
  if (detail.amount !== null) { patch.amount = detail.amount; if (detail.currency) patch.currency = detail.currency; }
  if (evidence) { patch.payState = 'paid'; if (!ae.paid_at) patch.paidAt = d.now(); }
  if (first) {
    patch.trackingNumber = first.trackingNumber;
    if (first.carrier) patch.carrier = first.carrier;
    if (first.etaMs) patch.etaAt = new Date(first.etaMs);
    if (first.lastEvent) patch.lastEvent = first.lastEvent;
  }
  const saved = await d.update(userId, orderId, patch, guard);
  return saved ? { order: saved, detail } : changed;
}

/** An amount from the browser: a finite number, or text that is only a number. null / '' / [] / false / true are NOT amounts (Number() turns them all into 0 or 1). */
function strictAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) return Number(value.trim());
  return null;
}

/** What AliExpress actually created must be exactly what ELMS meant to order: one line, this product, this option, this quantity. Returns the difference in words, or null. */
function itemMismatch(detail, listing, order) {
  if (!listing || !listing.aliexpress_product_id || !listing.aliexpress_sku_id) return 'ELMS cannot tell which product this order was meant for';
  const lines = Array.isArray(detail.lines) ? detail.lines : [];
  if (lines.length !== 1) return lines.length ? `it has ${lines.length} item lines, ELMS ordered one` : 'AliExpress did not list its items';
  const line = lines[0];
  const quantity = Math.max(1, Math.trunc(Number(order.quantity) || 1));
  if (String(line.productId) !== String(listing.aliexpress_product_id)) return `it is for product ${line.productId || '?'}, not ${listing.aliexpress_product_id}`;
  if (String(line.skuId) !== String(listing.aliexpress_sku_id)) return `it is for option ${line.skuId || '?'}, not ${listing.aliexpress_sku_id}`;
  if (Number(line.quantity) !== quantity) return `it is for ${line.quantity == null ? '?' : line.quantity} piece(s), not ${quantity}`;
  return null;
}

/**
 * Step 3 - pays the order. Needs `confirm: true`, and `expectedAmount` + `expectedCurrency`: the total the seller was shown. AliExpress's
 * current order is read first and the payment goes ahead ONLY if
 *   - it is for exactly what ELMS meant to order (one line: this product, this option, this quantity),
 *   - AliExpress shows it as WAITING for payment (any other status - or none - is refused: fail closed),
 *   - amount AND currency are the same ones the seller saw (otherwise nothing is paid and the new amount comes back to be confirmed again).
 * An order AliExpress already shows as paid is not paid twice, one that eBay shows as cancelled / refunded / unpaid / shipped is not paid at
 * all, and an order AliExpress split into several is left to the seller. The payment itself is taken with an atomic claim (pay_state
 * 'paying'), so two clicks can never send two payments. "Paid" is only written once AliExpress SHOWS the payment; an accepted request that
 * is not visible yet stays 'paying' (`pending`) and the next refresh decides.
 * @returns {Promise<{ order, pending?, alreadyPaid? } | { error: 'not_found'|'not_placed'|'confirm'|'shipped'|'cancelled'|'not_paid'|'multiple'|'no_amount'|'not_payable'|'wrong_item'|'amount_changed'|'claimed'|'not_accepted'|'pay_unclear', message, amount?, currency? }>}
 */
async function payOrder(userId, orderId, { confirm = false, expectedAmount, expectedCurrency } = {}, d = deps) {
  if (confirm !== true) return { error: 'confirm', message: 'Paying needs the seller\'s confirmation.' };
  const order = await d.getOrder(userId, orderId);
  if (!order) return { error: 'not_found' };
  const ae = order.aliexpress_order;
  if (!ae || ae.state !== 'placed' || !ae.ae_order_id) return { error: 'not_placed', message: 'No AliExpress order was placed for this line.' };
  if (ae.pay_state === 'paid') return { order, alreadyPaid: true };

  // The checks the preview made before ordering are made again: days may have passed, and the buyer may have cancelled or been refunded.
  if (isShipped(order)) return { error: 'shipped', message: 'This order is already shipped, so there is nothing to pay for. Cancel the AliExpress order if you do not need it.' };
  if (isCancelled(order)) return { error: 'cancelled', message: 'This order was cancelled (or a cancellation is open) on eBay - do not pay for it. If you do not want it, cancel the AliExpress order.' };
  if (isUnpaidOnEbay(order)) return { error: 'not_paid', message: `eBay shows this order as "${order.ebay_payment_status || 'awaiting payment'}", not paid - do not pay for it.` };
  // ELMS follows ONE AliExpress order per line. Several (AliExpress split it) would need every one checked and paid - left to the seller.
  const ids = aeOrderIdsOf(ae);
  if (ids.length > 1) return { error: 'multiple', message: `AliExpress split this into ${ids.length} orders (${ids.join(', ')}). ELMS pays only a single order and does not follow split orders - pay them on AliExpress yourself.` };

  const adapter = d.adapter();
  const detail = await adapter.getOrderDetail(userId, ae.ae_order_id);
  if (!detail || !(detail.amount > 0)) return { error: 'no_amount', message: 'AliExpress did not say how much this order costs, so it will not be paid. Press "Refresh" and try again.' };
  const guard = { state: 'placed', aeOrderId: ae.ae_order_id };
  if (hasPaymentEvidence(detail)) {
    const updated = await d.update(userId, orderId, { payState: 'paid', paidAt: ae.paid_at ? undefined : d.now(), status: detail.status, amount: detail.amount, currency: detail.currency || undefined, syncedAt: d.now() }, guard);
    if (!updated) return { error: 'changed', message: 'This order changed while it was being read. Press "Refresh" and look again.' };
    return { order: updated, alreadyPaid: true };
  }
  if (!isAwaitingPayment(detail)) return { error: 'not_payable', message: `AliExpress shows this order as "${detail.status || 'no status'}", not as waiting for payment, so ELMS will not pay it. Look at it on AliExpress.` };
  const listing = order.listing_id ? await d.getListing(userId, order.listing_id) : null;
  const mismatch = itemMismatch(detail, listing, order);
  if (mismatch) return { error: 'wrong_item', message: `The AliExpress order is not what ELMS meant to order (${mismatch}). Do not pay it from here - look at it on AliExpress and cancel it there if it is wrong.` };

  // The currency to pay in: the one AliExpress reports, else the one ELMS asked for when it placed the order. With neither, there is nothing to check against.
  const payCurrency = detail.currency || (ae.currency ? String(ae.currency).toUpperCase() : null);
  if (!payCurrency) return { error: 'no_amount', message: 'AliExpress did not say which currency this order is in, so it will not be paid. Press "Refresh" and try again.' };
  const expected = strictAmount(expectedAmount);
  const seenCurrency = typeof expectedCurrency === 'string' ? expectedCurrency.trim().toUpperCase() : '';
  const currencyOk = seenCurrency === payCurrency;
  if (expected === null || !currencyOk || Math.abs(expected - detail.amount) > 0.009) {
    await d.update(userId, orderId, { amount: detail.amount, currency: payCurrency, status: detail.status, syncedAt: d.now() }, guard);
    const asked = `${detail.amount.toFixed(2)} ${payCurrency}`;
    const notSeen = expected === null || !seenCurrency;
    return {
      error: 'amount_changed',
      message: `AliExpress now asks for ${asked}` + (notSeen ? '. Confirm that amount to pay.' : `, not the ${`${expected.toFixed(2)} ${seenCurrency}`.trim()} you saw.`),
      amount: detail.amount, currency: payCurrency,
    };
  }

  const claimed = await d.claimPayment(userId, orderId);
  if (!claimed) return { error: 'claimed', message: 'A payment for this order is being made right now (or it is already paid). Press "Refresh" in a minute.' };
  let paid;
  try {
    paid = await adapter.payOrder(userId, ids[0]);
  } catch (err) {
    // Turned away before any payment logic ran: nothing was paid, the claim is given back. Anything else (a timeout, a code ELMS does not know)
    // is unclear - the payment MAY have gone through - so the claim stays ("paying" for a few minutes) and the seller is told to check first.
    if (err && err.rejected === true) {
      await d.releasePayment(userId, orderId);
      return { error: 'not_accepted', message: (err.message || 'AliExpress did not accept the payment.') };
    }
    return { error: 'pay_unclear', message: 'AliExpress did not give a clear answer, so ELMS does not know if the payment went through. Do NOT pay again yet: press "Refresh" (or look at the order on AliExpress). If it is still unpaid after 15 minutes you can pay again.' };
  }
  if (!paid.paid) {
    await d.releasePayment(userId, orderId);
    return { error: 'not_accepted', message: paid.message || 'AliExpress did not accept the payment. Check the balance / payment method of your AliExpress account.' };
  }
  console.log(`[aliexpress-order] payment accepted for AliExpress order ${ids[0]}, order ${orderId} (user ${userId}): ${detail.amount.toFixed(2)} ${payCurrency}`);
  // "Request accepted" is not "paid" (a payment can still fail afterwards, e.g. a balance that is too low): the order is only marked paid when
  // AliExpress SHOWS the payment. Until then it stays 'paying' - the next Refresh (or the job) decides, and pays are refused meanwhile.
  let after = null;
  try { after = await adapter.getOrderDetail(userId, ids[0]); } catch (_) { after = null; }
  const confirmed = hasPaymentEvidence(after);
  const patch = confirmed
    ? { payState: 'paid', paidAt: d.now(), status: after.status, amount: detail.amount, currency: payCurrency, syncedAt: d.now() }
    : { status: after && after.status ? after.status : undefined, syncedAt: d.now() };
  let updated;
  try { updated = await saveWithRetry(d, userId, orderId, patch); } catch (err) {
    console.error(`[aliexpress-order] PAYMENT SENT for AliExpress order ${ids[0]} (order ${orderId}, user ${userId}) but it could not be saved: ${err.message}`);
    throw Object.assign(new Error(`The payment WAS sent to AliExpress (order ${ids[0]}) but ELMS could not save it. Do not pay again - look at the order on AliExpress.`), { irreversible: true });
  }
  if (confirmed) return { order: updated };
  return { order: updated, pending: true, message: 'AliExpress accepted the payment but does not show the order as paid yet. Press "Refresh" in a minute. Do not pay again.' };
}

/**
 * "This AliExpress order is dead - let me order again." Frees the line of a PLACED order that AliExpress itself shows as closed / cancelled /
 * finished, with no parcel: e.g. the supplier cancelled a paid order and refunded it, which ELMS cannot tell from a delivered one (both end
 * as FINISH) and so never frees by itself. Needs the seller's confirm:true. Refused while AliExpress shows the order as anything but dead, when
 * it lists a parcel (the goods may still arrive), when the eBay order is already shipped, or when AliExpress split the order. Nothing is
 * sent to AliExpress; the old order's number stays in the log and in the message on the line.
 * @returns {Promise<{ order } | { error: 'not_found'|'not_placed'|'confirm'|'shipped'|'multiple'|'release_blocked'|'changed', message? }>}
 */
async function releaseOrder(userId, orderId, { confirm = false } = {}, d = deps) {
  if (confirm !== true) return { error: 'confirm', message: 'Releasing an order needs the seller\'s confirmation.' };
  const order = await d.getOrder(userId, orderId);
  if (!order) return { error: 'not_found' };
  const ae = order.aliexpress_order;
  if (!ae || ae.state !== 'placed' || !ae.ae_order_id) return { error: 'not_placed', message: 'No AliExpress order was placed for this line.' };
  if (isShipped(order)) return { error: 'shipped', message: 'This order is already shipped on eBay, so it is not ordered again.' };
  const ids = aeOrderIdsOf(ae);
  if (ids.length > 1) return { error: 'multiple', message: `AliExpress split this into ${ids.length} orders (${ids.join(', ')}). ELMS does not follow split orders, so it cannot tell if they are all dead.` };
  const detail = await d.adapter().getOrderDetail(userId, ae.ae_order_id);
  if (!detail) return { error: 'release_blocked', message: 'AliExpress sent back nothing for this order, so ELMS cannot see that it is closed.' };
  if (!/^(FINISH|CLOSED|CANCEL)/i.test(String(detail.status || ''))) return { error: 'release_blocked', message: `AliExpress shows this order as "${detail.status || 'no status'}" - it is not closed or cancelled, so it cannot be released.` };
  if (detail.logistics.length > 0 || detail.logisticsStatus || ae.tracking_number) return { error: 'release_blocked', message: 'AliExpress shows a parcel for this order, so it was not cancelled - the goods may still arrive. Look at it on AliExpress.' };
  console.log(`[aliexpress-order] released AliExpress order ${ae.ae_order_id} (status ${detail.status}) of order ${orderId} (user ${userId}) at the seller's request`);
  const released = await d.update(userId, orderId, {
    state: 'failed', payState: 'unpaid', status: detail.status, logisticsStatus: detail.logisticsStatus, syncedAt: d.now(), finished: true,
    error: `You released the AliExpress order ${ae.ae_order_id} (AliExpress shows it as ${detail.status}). ELMS no longer follows it. You can place a new order.`, errorCode: 'RELEASED',
  }, { state: 'placed', aeOrderId: ae.ae_order_id });
  return released ? { order: released } : { error: 'changed', message: 'This order changed while it was being read. Press "Refresh" and look again.' };
}

module.exports = { previewOrder, placeOrder, payOrder, refreshOrder, releaseOrder, strictAmount, itemMismatch, hasPaymentEvidence, isAwaitingPayment, OVERRIDE_FLAG, splitPhone, addressOf, toLogisticsAddress, outOrderIdFor, explainError, isFinishedStatus, deps, COUNTRY_DIAL };
