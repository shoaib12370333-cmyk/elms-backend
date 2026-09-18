/**
 * Centralized, AutoDS-style credit costs for every billable action in
 * ELMS. Keeping this in one place means:
 *   - it's easy to see/audit what costs what
 *   - changing a price is a one-line edit, not a hunt through every route
 *   - future actions (Auto Order, Tracking Conversion, etc.) have an
 *     obvious place to be added, even before they're implemented
 *
 * A cost of 0 means the action is free (still logged/tracked, just not
 * charged) - this documents intent (e.g. "we've decided this stays free")
 * rather than simply having no charging code at all for it.
 */
const ACTION_COSTS = {
  AMAZON_IMPORT: 1, // fetching a product from Amazon by link - website Import page, bulk import, AND the extension's popup "Fetch by Link" all share this one (all three call the same Canopy-backed route)
  BROWSER_IMPORT_SCRAPE: 1, // extension's floating-button import - reads the currently open Amazon page's DOM directly, no Canopy call
  EBAY_PUBLISH: 1, // publishing a draft to eBay
  SCHEDULED_PUBLISH: 1, // a scheduled listing going live automatically
  REPUBLISH: 1, // retrying a failed/ended listing
  VARIANT_REFRESH: 0, // re-fetching variant data for an existing product - FREE
  STOCK_MONITORING: 1, // one Amazon stock check for a published listing
  PRICE_MONITORING: 0, // Amazon price check for a published listing - FREE (piggybacked on the stock check's Canopy call in jobs/stockMonitor.js, so it costs no extra Canopy call or credit)

  // Order sync is charged once per day (not per sync run) based on the
  // user's chosen mode - see jobs/orderSync.js for where this daily charge
  // is applied. Realtime costs more since it requires maintaining a live
  // eBay webhook subscription in addition to the safety-net poll.
  ORDER_SYNC_REALTIME_DAILY: 10,
  ORDER_SYNC_POLLING_DAILY: 5,

  // Not yet implemented - reserved here so the cost model doesn't need to
  // change shape when these features are built.
  AUTO_ORDER: 1, // placing/assisting an Amazon order for a buyer's eBay order (planned)
  TRACKING_CONVERSION: 0, // converting/validating a tracking number for eBay (planned) - FREE

  // Research tools (Canopy API-powered) - each is a single lookup, priced
  // like a standard Amazon data fetch since each one makes at least one
  // Canopy API call.
  KEYWORD_RANK_CHECKER: 1, // one keyword-vs-ASIN rank lookup (may page through search results internally)
  REVIEW_ANALYZER: 1, // fetching a product's reviews and ratings breakdown
  BESTSELLER_EXPLORER: 1, // browsing a category's top-ranked products
  CATEGORY_FINDER: 1, // finding which categories a product belongs to
  LISTING_GRADER: 1, // scoring a listing's title/bullets/images/reviews
  IMAGE_EXTRACTOR: 0, // pulling a product's images - FREE (images are already included in every product fetch)
};

/**
 * Human-readable metadata for every ACTION_COSTS key, purely for display in
 * the Admin Panel's "Credit Costs" list - lets an admin see, at a glance,
 * what each action does and whether it spends a (separately billed) Canopy
 * API call, before changing what it charges the user. Editing a cost here
 * in code only sets the DEFAULT - once an admin saves a value from the
 * Admin Panel, the database override takes precedence (see
 * models/settingsModel.js applyActionCostOverridesOnStartup /
 * updateActionCosts) until it's cleared.
 */
const ACTION_COST_METADATA = [
  { key: 'AMAZON_IMPORT', label: 'Amazon import (website / bulk / Fetch by Link)', usesCanopy: true, description: 'Fetching one product from an Amazon link - the website Import page, bulk import, and the extension popup\'s "Fetch by Link" button all use this.' },
  { key: 'BROWSER_IMPORT_SCRAPE', label: 'Amazon import (extension floating button)', usesCanopy: false, description: 'Reading the currently open Amazon product page directly in the browser - no Canopy call, since the page is already loaded.' },
  { key: 'EBAY_PUBLISH', label: 'Publish to eBay', usesCanopy: false, description: 'Publishing a draft listing to eBay.' },
  { key: 'SCHEDULED_PUBLISH', label: 'Scheduled publish', usesCanopy: false, description: 'A scheduled listing going live automatically at its scheduled time.' },
  { key: 'REPUBLISH', label: 'Republish', usesCanopy: false, description: 'Retrying a failed or ended listing.' },
  { key: 'VARIANT_REFRESH', label: 'Variant refresh', usesCanopy: true, description: 'Re-fetching variant data for an existing imported product.' },
  { key: 'STOCK_MONITORING', label: 'Stock monitoring (daily)', usesCanopy: true, description: 'Automatic daily in-stock/out-of-stock check for every published listing.' },
  { key: 'PRICE_MONITORING', label: 'Price monitoring (daily)', usesCanopy: true, description: 'Automatic daily Amazon price check - reuses the same Canopy call as Stock monitoring, so it never adds an extra Canopy call even though it does read Canopy data.' },
  { key: 'ORDER_SYNC_REALTIME_DAILY', label: 'Order sync - real-time (per day)', usesCanopy: false, description: 'Daily charge for a user on real-time order sync (eBay webhook + safety-net poll).' },
  { key: 'ORDER_SYNC_POLLING_DAILY', label: 'Order sync - polling only (per day)', usesCanopy: false, description: 'Daily charge for a user on polling-only order sync (no live webhook).' },
  { key: 'AUTO_ORDER', label: 'Auto order (planned)', usesCanopy: false, description: 'Placing/assisting an Amazon order for a buyer’s eBay order. Not yet implemented.' },
  { key: 'TRACKING_CONVERSION', label: 'Tracking conversion (planned)', usesCanopy: false, description: 'Converting/validating a tracking number for eBay. Not yet implemented.' },
  { key: 'KEYWORD_RANK_CHECKER', label: 'Keyword Rank Checker', usesCanopy: true, description: 'One keyword-vs-ASIN rank lookup - may page through several Canopy search-result pages internally for a single lookup.' },
  { key: 'REVIEW_ANALYZER', label: 'Review Analyzer', usesCanopy: true, description: 'Fetching a product’s reviews and ratings breakdown.' },
  { key: 'BESTSELLER_EXPLORER', label: 'Bestseller Explorer', usesCanopy: true, description: 'Browsing a category’s top-ranked products.' },
  { key: 'CATEGORY_FINDER', label: 'Category Finder', usesCanopy: true, description: 'Finding which categories a product belongs to.' },
  { key: 'LISTING_GRADER', label: 'Listing Grader', usesCanopy: true, description: 'Scoring a listing’s title/bullets/images/reviews.' },
  { key: 'IMAGE_EXTRACTOR', label: 'Image Extractor', usesCanopy: false, description: 'Pulling a product’s images - free, they’re already included in every product fetch.' },
];

module.exports = { ACTION_COSTS, ACTION_COST_METADATA };
