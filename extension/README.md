# ELMS Amazon Importer

Chrome MV3 extension that reads the product currently open on an Amazon product page and imports the normalized data into ELMS Drafts.

## User flow
1. In ELMS, open Settings and copy the personal **ELMS Extension Key**.
2. Paste that key into the extension once.
3. Open an Amazon product page. The **ELMS panel** (the chip above the ELMS button) shows what you would keep and what to watch out for.
4. Press the ELMS button on the page, or **Import current Amazon product** in the popup (or the shortcut **Alt+Shift+E**).

The extension does **not** expose an editable backend URL and does **not** have a Fetch by Link feature. The API endpoint is centrally controlled by the ELMS Admin Panel and bootstrapped from the canonical ELMS backend.

Product images are limited to Amazon's product gallery/A+ areas and video thumbnails/player posters are filtered out.

## The ELMS panel (v3.4)
A chip on every Amazon product page ("Profit £2.42 · 4 warnings"); click it for the details.

- **Profit**: Amazon price, the eBay price at your markup, eBay fees, **what you keep** (and the margin), the break-even price and the price for your wanted profit, with a **Use N%** button that sets the markup. eBay takes its fees from what the buyer pays, so a small markup can be a loss (a 10% markup on an 8.00 cost is). The fees (default 13% + 0.30, promoted listing %, wanted profit %) are set in the popup under *Profit settings*; the maths is the one of the ELMS Price Calculator (`logic.js`).
- **Already in ELMS**: the product is checked against your drafts and live listings by ASIN, per store. A draft is refreshed for another credit (asked once); a product that is live, paused, scheduled, ended or being published is **not imported again** (the server refuses it and no credit is spent). A live listing shows what Amazon's price did since you listed it and what you keep now.
- **Checks**: VeRO words (your own list from Settings) in the title, brand and bullet points; the Amazon site not matching the chosen store; not enough credits; no price; unavailable; a deal price; sold by a third party; slow delivery (English delivery dates); low rating; few pictures; number of variants.
- **Store**: with more than one eBay store connected, choose which store the draft goes to (panel and popup). The store must match the Amazon site (a UK store takes amazon.co.uk).
- **Credits**: what one import costs and what you have; after an import, what is left.
- **Open in ELMS**: after an import the popup offers *Open the draft in ELMS* (`/draft?open=<id>`); an option opens it automatically.
- The panel's checks with ELMS are free and use no credit. If ELMS cannot be reached (a sleeping server) the profit and page checks still work.
- The floating button now imports at the markup shown in the panel (it used to ignore the popup's markup and import at 0%).

## Bulk import (v3.5)
On a search-results or bestseller page every product gets a small **+ ELMS** badge. Tick the ones you want, open the **Bulk import** chip and press *Import N products*.
- A product ELMS already has in the chosen store shows **In Drafts** or **In ELMS** and cannot be ticked (up to 100 products at a time).
- The products go to the chosen store at the markup in the panel. ELMS fetches them itself (1 credit each, `POST /api/fetch-product/bulk-job` in the background - you can close the page - or, without background imports, a few at a time through `/bulk`). Variant pictures are not part of this fetch: import a product that has variants from its own page.
- A product that cannot be imported (already live, paused, scheduled ...) is skipped **without spending a credit**; the website's bulk import and Import page follow the same rule now.
- A background import is saved into the store it was started for (it used to use whichever store was active when the product was saved).

## Options (popup)
- *Open the draft in ELMS after an import.*
- *Import only the option shown*: does not read the other colours / sizes (use it when Amazon asks for a captcha).
- Keyboard shortcut **Alt+Shift+E** (change it at `chrome://extensions/shortcuts`).

## Look (v3.3.1)
The ELMS wordmark is the extension's logo everywhere: the toolbar icon, the popup header and the button on Amazon pages (`icon-*.png`, `logo-wordmark.png`, `logo.png`).

## What it reads (v3.3)
- Title, description, bullet points, price, brand, categories and **every item specification** on the page.
- **All gallery pictures** of the product, full size.
- **Variants** (colour, size, ...): for each one its ASIN, what makes it different (dimensions), its **own title**, its **own pictures**, price and stock. The colour / size picker's data is read from the page, and each variant's own product page is opened in the background (same Amazon site, at most 30 variants, three at a time, about 25 seconds at most) to get its pictures and title. If Amazon asks for a captcha, reading variants stops and the variants keep their picker picture and name.

## Files
- `content.js` reads the page and draws the panel; `logic.js` is the maths and the checks (no page access, tested in `tests/extensionLogic.test.js`); `background.js` talks to ELMS (renews an expired session, opens ELMS pages, the shortcut); `popup.html` / `popup.js` connect, choose the store and set the options.
- Server side: `POST /api/extension/check` (free: credits, stores, what you already have, VeRO words), `POST /api/extension/known` (free: what you already have for up to 100 ASINs) and `POST /api/browser-import` (accepts `ebayAccountId`; so do `/api/fetch-product/bulk` and `/bulk-job`).
