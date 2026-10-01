const express = require('express');
const router = express.Router();
const { ordersSummary, listOrders, updateFulfillmentStatus, upsertOrder, getOrderById, setTracking, markShippedNoTracking, linkAmazonOrder, setSellerNote, setEbayNoteState, markOrdered, setBuyPrice, linkOrderToListing } = require('../models/ordersModel');
const { listEbayAccounts, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const EbayAccount = require('../models/schemas/EbayAccount');
const { fetchOrderById, normalizeOrderLineItems, createShippingFulfillment } = require('../services/ebayOrdersService');
const { syncAccountOrders } = require('../services/orderSyncService');
const { backfillOrderImagesForUser, fillMissingOrderImages } = require('../services/orderImageService');
const { convertTracking } = require('../services/trackingConversionService');
const { createOrGetForOrder: createOrGetTrackingLink, getForOrder: getTrackingLinkForOrder } = require('../models/trackingLinksModel');
const { requireAuth } = require('../middleware/requireAuth');
const { fetchAndSaveDraft } = require('./fetchProduct');
const { getEbayAccountById } = require('../models/ebayAccountsModel');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');
const { hasCredits } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { isValidAmazonUrl, COUNTRY_TO_AMAZON_DOMAIN } = require('../services/validationService');
const { startJob, getJob } = require('../services/backgroundJobs');

const syncJobKey = (userId, accountId) => `orders:${userId}:${accountId || 'all'}`;

/** Reads the orders of these eBay accounts from eBay and saves them. Returns { syncedCount, ordersFromEbay, errors }. */
async function syncOrdersOf(userId, accounts, full) {
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const { ordersFromEbay, savedCount } = await syncAccountOrders(userId, account.id, { full });
      return { savedCount, ordersFromEbay };
    } catch (err) {
      console.error(`order sync error for account ${account.ebayUserId}:`, err.message);
      return { savedCount: 0, ordersFromEbay: 0, error: `${account.ebayUserId}: ${err.message}` };
    }
  }));
  const errors = results.map((r) => r.error).filter(Boolean);
  return {
    syncedCount: results.reduce((sum, r) => sum + r.savedCount, 0),
    ordersFromEbay: results.reduce((sum, x) => sum + (x.ordersFromEbay || 0), 0),
    errors,
  };
}

/**
 * GET /api/orders?accountId=...
 * Requires a valid session token.
 * Returns the current user's orders across ALL of their connected eBay
 * accounts by default (a combined view), or filtered to one account if
 * accountId is given.
 */
router.get('/', requireAuth, async (req, res) => {
  const orders = await listOrders(req.userId, req.query.accountId);
  res.json({ success: true, orders });
  backfillOrderImagesForUser(req.userId); // orders without a picture get theirs from eBay in the background; the next load shows them
});


/**
 * GET / PUT /api/orders/ebay-note-setting   { enabled: boolean }
 * The seller's switch for writing "ELMS: ordered <date>" in the private note of the eBay order when they mark an order as ordered (off by default).
 * Must stay above PUT /:id.
 */
router.get('/ebay-note-setting', requireAuth, async (req, res) => {
  try {
    const user = await require('../models/schemas/User').findById(req.userId).select('ebayOrderNote').lean();
    res.json({ success: true, enabled: !!(user && user.ebayOrderNote) });
  } catch (err) {
    console.error('ebay note setting error:', err.message);
    res.status(500).json({ success: false, error: 'Could not read this setting.' });
  }
});
router.put('/ebay-note-setting', requireAuth, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled must be true or false.' });
  try {
    await require('../models/schemas/User').updateOne({ _id: req.userId }, { $set: { ebayOrderNote: req.body.enabled } });
    res.json({ success: true, enabled: req.body.enabled });
  } catch (err) {
    console.error('ebay note setting error:', err.message);
    res.status(500).json({ success: false, error: 'Could not save this setting.' });
  }
});

/**
 * GET / PUT /api/orders/auto-message-settings   { thankYou, reviewRequest, ordered, orderedText, shipped, shippedText }
 * The seller's switches for the four automatic eBay buyer messages (services/autoBuyerMessageService.js): a one-time
 * "thanks for your order" the moment a line is first seen as paid, a one-time "it shipped, please leave a review"
 * the moment tracking is first saved, a one-time "we've ordered it, on its way to us" the moment the seller marks an
 * order as ordered, and a one-time "it has shipped" the moment an order is marked shipped (with or without
 * tracking). All off by default - nothing is ever sent, not even a draft, unless switched on here. "ordered"/
 * "shipped" can have the seller's own wording (orderedText/shippedText, supports {{buyer_name}}/{{product_name}}) -
 * empty/omitted falls back to the built-in default text (buyerMessageService.js). Must stay above PUT /:id.
 */
router.get('/auto-message-settings', requireAuth, async (req, res) => {
  try {
    const user = await require('../models/schemas/User').findById(req.userId).select('autoThankYouMessage autoReviewRequestMessage autoOrderedMessage orderedMessageText autoShippedMessage shippedMessageText').lean();
    res.json({
      success: true,
      thankYou: !!(user && user.autoThankYouMessage),
      reviewRequest: !!(user && user.autoReviewRequestMessage),
      ordered: !!(user && user.autoOrderedMessage),
      orderedText: (user && user.orderedMessageText) || '',
      shipped: !!(user && user.autoShippedMessage),
      shippedText: (user && user.shippedMessageText) || '',
    });
  } catch (err) {
    console.error('auto message settings error:', err.message);
    res.status(500).json({ success: false, error: 'Could not read these settings.' });
  }
});
router.put('/auto-message-settings', requireAuth, async (req, res) => {
  const { thankYou, reviewRequest, ordered, orderedText, shipped, shippedText } = req.body || {};
  if (thankYou !== undefined && typeof thankYou !== 'boolean') return res.status(400).json({ success: false, error: 'thankYou must be true or false.' });
  if (reviewRequest !== undefined && typeof reviewRequest !== 'boolean') return res.status(400).json({ success: false, error: 'reviewRequest must be true or false.' });
  if (ordered !== undefined && typeof ordered !== 'boolean') return res.status(400).json({ success: false, error: 'ordered must be true or false.' });
  if (shipped !== undefined && typeof shipped !== 'boolean') return res.status(400).json({ success: false, error: 'shipped must be true or false.' });
  if (orderedText !== undefined && typeof orderedText !== 'string') return res.status(400).json({ success: false, error: 'orderedText must be text.' });
  if (shippedText !== undefined && typeof shippedText !== 'string') return res.status(400).json({ success: false, error: 'shippedText must be text.' });
  if (typeof orderedText === 'string' && orderedText.length > 1000) return res.status(400).json({ success: false, error: 'That message is too long (1000 characters max).' });
  if (typeof shippedText === 'string' && shippedText.length > 1000) return res.status(400).json({ success: false, error: 'That message is too long (1000 characters max).' });
  try {
    const set = {};
    if (thankYou !== undefined) set.autoThankYouMessage = thankYou;
    if (reviewRequest !== undefined) set.autoReviewRequestMessage = reviewRequest;
    if (ordered !== undefined) set.autoOrderedMessage = ordered;
    if (shipped !== undefined) set.autoShippedMessage = shipped;
    if (orderedText !== undefined) set.orderedMessageText = orderedText.trim() || null;
    if (shippedText !== undefined) set.shippedMessageText = shippedText.trim() || null;
    const User = require('../models/schemas/User');
    await User.updateOne({ _id: req.userId }, { $set: set });
    const user = await User.findById(req.userId).select('autoThankYouMessage autoReviewRequestMessage autoOrderedMessage orderedMessageText autoShippedMessage shippedMessageText').lean();
    res.json({
      success: true,
      thankYou: !!user.autoThankYouMessage,
      reviewRequest: !!user.autoReviewRequestMessage,
      ordered: !!user.autoOrderedMessage,
      orderedText: user.orderedMessageText || '',
      shipped: !!user.autoShippedMessage,
      shippedText: user.shippedMessageText || '',
    });
  } catch (err) {
    console.error('auto message settings error:', err.message);
    res.status(500).json({ success: false, error: 'Could not save these settings.' });
  }
});

/**
 * GET /api/orders/sync-status?accountId=...
 * How the background order sync is going: { status: 'running' | 'done' | 'error', result?: { syncedCount, ordersFromEbay,
 * errors }, error? }, or job null when none was started lately. Must stay above GET /:id.
 */
router.get('/sync-status', requireAuth, (req, res) => {
  res.json({ success: true, job: getJob(syncJobKey(req.userId, req.query.accountId || null)) });
});

/**
 * GET /api/orders/processing
 * Returns orders that still need seller action. This is the usable part of
 * the Semi-Auto workflow: ELMS can prepare the order, while the seller places
 * the Amazon order manually until a buyer-account adapter is available.
 */
/**
 * GET /api/orders/summary?accountId=
 * For the dashboard: how many orders, and the revenue and profit per currency, without sending every order (light; kept for a minute).
 */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await ordersSummary(req.userId, /^[a-f0-9]{24}$/i.test(String(req.query.accountId || '')) ? String(req.query.accountId) : null)) });
  } catch (err) {
    console.error('orders summary error:', err.message);
    res.status(500).json({ success: false, error: 'Could not load the order totals.' });
  }
});

router.get('/processing', requireAuth, async (req, res) => {
  const orders = await listOrders(req.userId, req.query.accountId);
  const pending = orders.filter((order) => ['pending', 'ordered_from_amazon'].includes(order.fulfillment_status));
  res.json({ success: true, orders: pending });
});

/**
 * POST /api/orders/sync
 * Requires a valid session token and at least one connected eBay account.
 *
 * Pulls recent orders from eBay's Fulfillment API for EVERY one of the
 * user's connected eBay accounts (not just one), and saves any new ones -
 * safe to call repeatedly, since existing orders are matched and updated
 * rather than duplicated (see models/ordersModel.upsertOrder).
 */
router.post('/sync', requireAuth, async (req, res) => {
  const requestedAccountId = req.query.accountId || null;
  const accounts = (await listEbayAccounts(req.userId))
    .filter((account) => !requestedAccountId || String(account.id) === String(requestedAccountId));
  if (!accounts.length) {
    return res.status(400).json({ success: false, error: requestedAccountId ? 'The selected eBay account is not connected.' : 'Please connect an eBay account first.' });
  }

  const full = req.query.full === '1' || req.query.full === 'true';

  // ?background=1: start the sync and answer at once; the page asks GET /sync-status until it is done, then loads the orders.
  if (req.query.background === '1') {
    const { started, job } = startJob(syncJobKey(req.userId, requestedAccountId), () => syncOrdersOf(req.userId, accounts, full));
    return res.status(202).json({ success: true, started, job });
  }

  const { syncedCount: savedCount, ordersFromEbay, errors } = await syncOrdersOf(req.userId, accounts, full);
  const orders = await listOrders(req.userId, requestedAccountId);
  res.json({ success: true, syncedCount: savedCount, ordersFromEbay, full, orders, errors: errors.length ? errors : undefined });
});


/**
 * PUT /api/orders/:id/amazon-order
 * Semi-Auto workflow: seller manually places the Amazon order and links its
 * order ID back to ELMS. No Amazon buyer login or checkout is attempted here.
 */
router.put('/:id/amazon-order', requireAuth, async (req, res) => {
  try {
    const updated = await linkAmazonOrder(
      req.userId,
      req.params.id,
      req.body?.amazonOrderId,
      req.body?.fulfillmentStatus || 'ordered_from_amazon'
    );
    if (!updated) return res.status(404).json({ success: false, error: 'Order not found.' });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/** A date from the order window ("2026-09-27", or a full ISO date) as a Date at noon UTC (no time zone can move it to another day); null when it is not a date. */
function orderDateOf(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1 ? null : d;
}
const moneyOrEmpty = (v) => v === null || v === '' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/**
 * POST /api/orders/:id/ordered   { ordered: boolean, deliveryDate?: 'YYYY-MM-DD' | null, buyingPrice?: number, orderEarning?: number }
 * "Mark as ordered" (and Undo) with what the seller fills in: the DELIVERY date (when the parcel from the supplier arrives; empty / null clears it, not given keeps
 * the one there) and (when given) the buying price and the order earning, which go into the Net Profit sheet by themselves (eBay cost and net profit are worked out
 * from them). "ELMS: ordered, delivery <date>" is saved in the order's private note in ELMS; writing it on eBay too is the separate POST /:id/ebay-note (only when
 * the seller switched that on). Answers with the order (with its new note, delivery date and net profit). An order that is already shipped is not turned back.
 */
router.post('/:id/ordered', requireAuth, async (req, res) => {
  const body = req.body || {};
  if (typeof body.ordered !== 'boolean') return res.status(400).json({ success: false, error: 'ordered must be true or false.' });
  // the delivery date: empty / null = none; a parcel can arrive in the future, but not years away (or before ELMS existed)
  let deliveryDate;
  if (body.ordered && body.deliveryDate !== undefined) {
    if (body.deliveryDate === null || body.deliveryDate === '') deliveryDate = null;
    else {
      deliveryDate = orderDateOf(body.deliveryDate);
      if (!deliveryDate || deliveryDate.getTime() < Date.UTC(2020, 0, 1) || deliveryDate.getTime() > Date.now() + 400 * 86400000) return res.status(400).json({ success: false, error: 'Choose a valid delivery date.' });
    }
  }
  if (body.buyingPrice !== undefined && !moneyOrEmpty(body.buyingPrice)) return res.status(400).json({ success: false, error: 'Enter the buying price as a number.' });
  if (body.orderEarning !== undefined && !moneyOrEmpty(body.orderEarning)) return res.status(400).json({ success: false, error: 'Enter the order earning as a number.' });
  const buying = body.buyingPrice === undefined || body.buyingPrice === null || body.buyingPrice === '' ? body.buyingPrice : Number(body.buyingPrice);
  const earning = body.orderEarning === undefined || body.orderEarning === null || body.orderEarning === '' ? body.orderEarning : Number(body.orderEarning);
  if (typeof buying === 'number' && (buying < 0 || buying > 1e9)) return res.status(400).json({ success: false, error: 'Enter the buying price as a number, 0 or more.' });
  if (typeof earning === 'number' && Math.abs(earning) > 1e9) return res.status(400).json({ success: false, error: 'That order earning is too large.' });
  try {
    const before = await getOrderById(req.userId, req.params.id);
    const out = await markOrdered(req.userId, req.params.id, { ordered: body.ordered, deliveryDate, buyingPrice: buying, orderEarning: earning });
    if (out.error === 'not_found') return res.status(404).json({ success: false, error: 'Order not found.' });
    if (out.error === 'shipped') return res.status(409).json({ success: false, error: 'This order is already shipped, so it cannot be marked as not ordered / ordered any more.' });

    // Fresh transition only - never on Undo, and never on re-editing the date/price of an order already marked ordered.
    const justOrdered = body.ordered && before && before.fulfillment_status !== 'ordered_from_amazon';
    if (justOrdered) {
      require('../services/autoBuyerMessageService').maybeSendOrderedUpdateMessage({
        userId: req.userId,
        orderId: out.order.id,
        ebayAccountId: out.order.ebay_account_id,
        buyerUsername: out.order.buyer_username,
        itemId: out.order.legacy_item_id,
        itemTitle: out.order.item_title,
        buyerFullName: out.order.shipping_address && out.order.shipping_address.fullName,
        justOrdered: true,
        alreadySent: !!out.order.ordered_message_at,
      }).catch((err) => console.warn('[auto-message] ordered-update trigger failed:', err.message));
    }

    res.json({ success: true, order: out.order });
  } catch (err) {
    console.error('mark ordered error:', err.message);
    res.status(500).json({ success: false, error: 'Could not save this. Please try again.' });
  }
});

/**
 * POST /api/orders/:id/ebay-note   { ordered: boolean, deliveryDate?: 'YYYY-MM-DD' }
 * After "Mark as ordered" (or Undo) in ELMS: writes (or takes out) "ELMS: ordered <date>" in the private note of the eBay order, keeping the seller's own
 * text (services/ebayOrderNoteService.js). Only when the seller switched it on. Answers { result: { status, message }, order } and never fails the mark itself:
 * status is written | removed | unchanged | skipped | failed, and the reason is kept on the order for the order window.
 */
router.post('/:id/ebay-note', requireAuth, async (req, res) => {
  if (typeof req.body?.ordered !== 'boolean') return res.status(400).json({ success: false, error: 'ordered must be true or false.' });
  try {
    const user = await require('../models/schemas/User').findById(req.userId).select('ebayOrderNote').lean();
    if (!(user && user.ebayOrderNote)) return res.status(403).json({ success: false, error: 'Writing the eBay note is switched off. Switch it on in Orders first.' });
    const order = await getOrderById(req.userId, req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
    let result;
    if (!order.ebay_account_id) result = { status: 'skipped', message: 'This order is not linked to an eBay store.' };
    else {
      const account = await getEbayAccountById(req.userId, order.ebay_account_id).catch(() => null);
      const refreshToken = account ? await getEbayAccountRefreshToken(req.userId, order.ebay_account_id) : null;
      const noteDate = orderDateOf(req.body.deliveryDate); // the delivery date the seller gave in "Mark as ordered": the same one is in the ELMS note
      result = await require('../services/ebayOrderNoteService').syncOrderNote(refreshToken, order.marketplace_id || (account && account.marketplaceId) || 'EBAY_US', { orderId: order.ebay_order_id, itemId: order.legacy_item_id, ordered: req.body.ordered, deliveryDate: noteDate });
    }
    const ok = ['written', 'removed', 'unchanged'].includes(result.status);
    // the mark is in the eBay note after "written" or when it was already there; it is out after "removed" or when it was not there
    const inEbay = ok ? (req.body.ordered ? true : false) : null;
    const updated = await setEbayNoteState(req.userId, req.params.id, { written: inEbay, error: ok ? null : result.message });
    res.json({ success: true, result, order: updated || order });
  } catch (err) {
    console.error('ebay note error:', err.message);
    res.status(500).json({ success: false, error: 'Could not update the eBay note. The order is still marked in ELMS.' });
  }
});

/**
 * PUT /api/orders/:id
 * Requires a valid session token.
 * Body: { fulfillmentStatus: string, amazonOrderId?: string }
 *
 * Updates an order's fulfillment status. Only works on orders owned by
 * the current user.
 */
router.put('/:id', requireAuth, async (req, res) => {
  const { fulfillmentStatus, amazonOrderId } = req.body;

  if (!fulfillmentStatus) {
    return res.status(400).json({ success: false, error: 'A fulfillmentStatus is required.' });
  }

  const updated = await updateFulfillmentStatus(req.userId, req.params.id, fulfillmentStatus, amazonOrderId);
  if (!updated) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }

  res.json({ success: true, order: updated });
});

/**
 * PUT /api/orders/:id/tracking
 * Requires a valid session token.
 * Body: { trackingNumber: string, shippingCarrier?: string }
 *
 * Saves a tracking number for an order and notifies eBay (so the buyer
 * sees it too), marking the order as shipped.
 */
router.post('/tracking/convert', requireAuth, async (req, res) => {
  try {
    const converted = convertTracking({
      trackingNumber: req.body?.trackingNumber,
      carrier: req.body?.carrier || req.body?.shippingCarrier,
    });
    res.json({ success: true, conversion: converted });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/:id/tracking-link
 * The buyer-facing tracking-page code for an order that already has a tracking number saved (null if none yet -
 * this never creates one; PUT /:id/tracking does that).
 */
router.get('/:id/tracking-link', requireAuth, async (req, res) => {
  const link = await getTrackingLinkForOrder(req.userId, req.params.id);
  res.json({ success: true, trackingCode: link?.code || null });
});

router.put('/:id/tracking', requireAuth, async (req, res) => {
  const { trackingNumber, shippingCarrier, carrier } = req.body;
  const sourceCarrier = shippingCarrier || carrier;

  if (!trackingNumber) {
    return res.status(400).json({ success: false, error: 'A trackingNumber is required.' });
  }

  const converted = convertTracking({ trackingNumber, carrier: sourceCarrier });
  const order = await getOrderById(req.userId, req.params.id);
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }

  // Try to notify eBay too, so the buyer can see the tracking info on
  // their end - but don't block saving it locally if that call fails
  // (e.g. missing eBay account access), since the seller still needs the
  // number recorded either way.
  let ebayNotified = false;
  let ebayError = null;
  if (order.ebay_order_id && order.ebay_line_item_id && order.ebay_account_id) {
    try {
      const refreshToken = await getEbayAccountRefreshToken(req.userId, order.ebay_account_id);

      if (refreshToken) {
        await createShippingFulfillment(
          refreshToken,
          order.ebay_order_id,
          order.ebay_line_item_id,
          order.quantity,
          converted.trackingNumber,
          converted.shippingCarrierCode
        );
        ebayNotified = true;
      }
    } catch (err) {
      ebayError = err.message;
      console.warn('Could not notify eBay of tracking number:', err.message);
    }
  }

  const updated = await setTracking(req.userId, req.params.id, converted.trackingNumber, converted.shippingCarrierCode);

  // Auto "it shipped, please leave a review" eBay buyer message: only the first time THIS order gets a tracking
  // number (any carrier - not tied to 17TRACK's own delivery confirmation), only once, only when the seller switched
  // it on. Fire-and-forget: the seller's "tracking saved" response should not wait on an eBay Message API round trip.
  const justShipped = updated && !order.tracking_number && !!converted.trackingNumber;
  if (justShipped) {
    const autoMessages = require('../services/autoBuyerMessageService');
    const payload = {
      userId: req.userId,
      orderId: updated.id,
      ebayAccountId: updated.ebay_account_id,
      buyerUsername: updated.buyer_username,
      itemId: updated.legacy_item_id,
      itemTitle: updated.item_title,
      buyerFullName: updated.shipping_address && updated.shipping_address.fullName,
      justShipped: true,
    };
    autoMessages.maybeSendReviewRequestMessage({ ...payload, alreadySent: !!updated.review_message_at }).catch((err) => console.warn('[auto-message] review-request trigger failed:', err.message));
    autoMessages.maybeSendShippedUpdateMessage({ ...payload, alreadySent: !!updated.shipped_message_at }).catch((err) => console.warn('[auto-message] shipped-update trigger failed:', err.message));
  }

  // A buyer-facing code for elmstool.com/track/<code> - never the real tracking number or carrier, so it never
  // says which supplier the order came from. Not fatal: the order is already saved above either way.
  let trackingCode = null;
  try {
    const link = await createOrGetTrackingLink(req.userId, req.params.id, converted.trackingNumber);
    trackingCode = link.code;
  } catch (err) {
    console.warn('Could not create a tracking page code:', err.message);
  }

  res.json({ success: true, order: updated, trackingConversion: converted, ebayNotified, ebayError, trackingCode });
});

/**
 * POST /api/orders/:id/mark-shipped
 * Marks an order as shipped on eBay with NO tracking number - for a seller who ships it themselves and has no
 * tracking number to enter (or doesn't have one yet but needs to beat eBay's ship-by deadline). Pushes a shipping
 * fulfillment to eBay with just the line item and today's date (services/ebayOrdersService.js createShippingFulfillment
 * omits trackingNumber/shippingCarrierCode entirely when none is given - eBay's API accepts that). A tracking number
 * can still be added afterwards through PUT /:id/tracking, exactly as if it had been entered from the start.
 */
router.post('/:id/mark-shipped', requireAuth, async (req, res) => {
  const order = await getOrderById(req.userId, req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });

  let ebayNotified = false;
  let ebayError = null;
  if (order.ebay_order_id && order.ebay_line_item_id && order.ebay_account_id) {
    try {
      const refreshToken = await getEbayAccountRefreshToken(req.userId, order.ebay_account_id);
      if (refreshToken) {
        await createShippingFulfillment(refreshToken, order.ebay_order_id, order.ebay_line_item_id, order.quantity);
        ebayNotified = true;
      }
    } catch (err) {
      ebayError = err.message;
      console.warn('Could not mark order as shipped on eBay (no tracking):', err.message);
    }
  }

  const updated = await markShippedNoTracking(req.userId, req.params.id);

  const justShipped = updated && !['shipped', 'delivered'].includes(order.fulfillment_status);
  if (justShipped) {
    const autoMessages = require('../services/autoBuyerMessageService');
    const payload = {
      userId: req.userId,
      orderId: updated.id,
      ebayAccountId: updated.ebay_account_id,
      buyerUsername: updated.buyer_username,
      itemId: updated.legacy_item_id,
      itemTitle: updated.item_title,
      buyerFullName: updated.shipping_address && updated.shipping_address.fullName,
      justShipped: true,
    };
    autoMessages.maybeSendReviewRequestMessage({ ...payload, alreadySent: !!updated.review_message_at }).catch((err) => console.warn('[auto-message] review-request trigger failed:', err.message));
    autoMessages.maybeSendShippedUpdateMessage({ ...payload, alreadySent: !!updated.shipped_message_at }).catch((err) => console.warn('[auto-message] shipped-update trigger failed:', err.message));
  }

  res.json({ success: true, order: updated, ebayNotified, ebayError });
});

/**
 * GET /api/orders/:id
 * One order with everything ELMS stores about it.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const order = await getOrderById(req.userId, req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
  res.json({ success: true, order });
});

/**
 * POST /api/orders/:id/import-product  { amazon }
 * For an order whose product is not in ELMS: imports the same product from Amazon (a link, or just the ASIN) exactly like a
 * normal import - it costs the same credits, refunded if saving fails, and the product also appears in Drafts - and links
 * the order (and other orders of the same eBay item) to it, so the Amazon price becomes its cost and profit is calculated.
 */
router.post('/:id/import-product', requireAuth, async (req, res) => {
  const order = await getOrderById(req.userId, req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });

  let url = String(req.body?.amazon || '').trim();
  if (/^[A-Z0-9]{10}$/i.test(url)) {
    // just the ASIN: use the Amazon site that matches the store the order came from
    const account = order.ebay_account_id ? await getEbayAccountById(req.userId, order.ebay_account_id) : null;
    const country = getMarketplaceConfig(account?.marketplaceId)?.country;
    url = `https://www.${COUNTRY_TO_AMAZON_DOMAIN[country] || 'amazon.com'}/dp/${url.toUpperCase()}`;
  }
  if (!isValidAmazonUrl(url)) return res.status(400).json({ success: false, error: 'Paste the Amazon product link (or its 10-character ASIN).' });
  if (!(await hasCredits(req.userId, ACTION_COSTS.AMAZON_IMPORT))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits.' });
  }

  try {
    const result = await fetchAndSaveDraft(req.userId, url, null, req);
    const linked = await linkOrderToListing(req.userId, req.params.id, result.draft.id);
    if (!linked) return res.status(500).json({ success: false, error: 'The product was imported but could not be linked to this order.' });
    res.json({
      success: true,
      order: await getOrderById(req.userId, req.params.id),
      product: { title: result.product.title, price: result.product.price ?? null, currency: result.product.currency || null },
      priceFound: result.product.price != null,
      linkedOrders: linked,
    });
  } catch (err) {
    console.error('order import-product error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not import this product.' });
  }
});

/**
 * PUT /api/orders/:id/buy-price  { price }
 * What one unit cost the seller (null / empty clears it). Profit uses it when the order's listing has no Amazon price.
 * Returns the order as the list shows it (with profit).
 */
router.put('/:id/buy-price', requireAuth, async (req, res) => {
  try {
    const saved = await setBuyPrice(req.userId, req.params.id, req.body?.price);
    if (!saved) return res.status(404).json({ success: false, error: 'Order not found.' });
    res.json({ success: true, order: await getOrderById(req.userId, req.params.id) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/orders/:id/note  { note }
 * Private seller note, stored only in ELMS.
 */
router.put('/:id/note', requireAuth, async (req, res) => {
  const order = await setSellerNote(req.userId, req.params.id, req.body?.note);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
  res.json({ success: true, order });
});

/**
 * POST /api/orders/:id/refresh
 * Re-reads this order from eBay right now (payment, shipping and cancel status)
 * and updates ELMS.
 */
router.post('/:id/refresh', requireAuth, async (req, res) => {
  const order = await getOrderById(req.userId, req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
  if (!order.ebay_account_id || !order.ebay_order_id) return res.status(400).json({ success: false, error: 'This order is not linked to an eBay account.' });
  try {
    const refreshToken = await getEbayAccountRefreshToken(req.userId, order.ebay_account_id);
    if (!refreshToken) return res.status(400).json({ success: false, error: 'The eBay account for this order is no longer connected.' });
    const raw = await fetchOrderById(refreshToken, order.ebay_order_id);
    const lineItems = normalizeOrderLineItems(raw);
    for (const lineItem of lineItems) await upsertOrder(req.userId, lineItem, order.ebay_account_id);
    await fillMissingOrderImages(req.userId, order.ebay_account_id, refreshToken, { legacyItemIds: lineItems.map((l) => l.legacyItemId).filter(Boolean), force: true }).catch(() => {});
    res.json({ success: true, order: await getOrderById(req.userId, req.params.id) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not refresh this order from eBay.' });
  }
});

module.exports = router;
