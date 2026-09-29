# ELMS Auto Order

Chrome MV3 extension that places the matching Amazon order for a paid eBay order, automatically, in your own logged-in Amazon session. This is a **separate** extension from the ELMS Amazon Importer (`extension/`) - that one gets products into ELMS, this one places Amazon orders once they sell.

## Before you turn this on

eBay's drop shipping policy does not allow fulfilling an order by buying it from another online retailer that ships directly to the buyer. Turning Auto Order on is your own decision, and your eBay and Amazon accounts stay your responsibility - ELMS only automates the click.

## Setup
1. In ELMS, open **Settings &rarr; Auto Order** and switch your mode to **Full-auto** (this is where the price limit, daily spending limit and Prime-only settings live).
2. Install this extension and paste your **ELMS Extension Key** into its popup - the same key the ELMS Amazon Importer uses. Both extensions can be connected at once.
3. Switch **Auto Order** on in this extension's own popup too - a second, local switch, so it never starts placing orders on a machine you didn't mean to leave it running on.
4. Leave Chrome open. Every few minutes the extension asks ELMS for the next ready order and, if there is one, opens the Amazon product and works through it.

## Manual mode - watch the first few orders before trusting it unattended
Switch **Manual mode** on in the popup and the next order behaves very differently:
- The Amazon tab opens **in the foreground** (not hidden), so you can actually watch it.
- Before every action that clicks or types anything - selecting the variant, clicking Buy Now/Add to Cart, proceeding to checkout, the address check, the optional "this is a gift" box, the seller/total check, and finally clicking Place your order - it **stops and waits**. The popup shows what it's about to do and a single **Do it** button; nothing happens until you press it (or press **Stop the current order now** instead).
- Turn Manual mode back off once you've watched a few go through correctly and you're confident in the selectors on your account/site - orders after that place themselves without asking.

## What it actually does, per order
1. Opens the product's own Amazon page (the exact page the listing was imported from, not a guessed link).
2. Selects the ordered variant (if one was recorded) and the quantity, then Buy Now (or Add to Cart &rarr; checkout).
3. On the review page: refuses to continue unless the buyer's postal code is visible in the selected shipping address (a mismatch is left for you to fix by hand - this extension never picks an address for you), and unless the item is in stock and (when the seller only allows Prime/Amazon-fulfilled items) sold and shipped by Amazon itself.
4. Reads the order total and checks it against the order's own allowed limit **before** clicking Place your order - this check happens in the background script, not just on the page, so it can't be fooled by a misread page.
5. Reads the Amazon order number off the confirmation page and reports it back to ELMS, which links it to the eBay order, writes it into the eBay order's private note, and shows it (with profit) on the Orders page.

## What it will not do
- Never place a second order for the same eBay order line (the backend's own unique index on the eBay line item makes sure of that, independently of this extension).
- Never guess past a captcha, a sign-in page, a two-factor prompt, an address that doesn't match, or any page it doesn't recognise - all of these are reported to ELMS as **needs attention** and left for you, visible (with a Retry button) on the Orders page.
- Never process more than one order at a time, and a pause/stop switch in the popup is always available.

## A note on Amazon's page layout
Amazon's product/checkout pages differ by country and change over time. The selectors this extension uses (`SELECTORS` at the top of `amazon-content.js`) are the long-standing, well-known ones, with generic text-based fallbacks for reading the order total and the confirmation number - but this has not been run against the live site from here. Run a supervised test (watch the background tab, or make it the active tab, on one cheap order) before relying on it unattended, and adjust `SELECTORS` if Amazon's markup has moved.

## Files
- `manifest.json` - MV3, host permissions for the Amazon sites ELMS supports plus the ELMS backend.
- `background.js` - the poll loop (`chrome.alarms`, every few minutes), the ELMS Extension Key auth (identical to the Importer's), and the one place that authorizes an actual purchase (`AO_CHECKS`).
- `amazon-content.js` - reads the Amazon page (product/cart/checkout/confirmation/captcha/sign-in/2FA) and drives the click-through, reporting each step back to `background.js`.
- `popup.html` / `popup.js` - connect/disconnect, the on/off and pause switches, the current job and recent history.
