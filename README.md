# ELMS Backend + Amazon Browser Importer

This build keeps the existing Canopy/Rapid integrations for API-backed operations such as variants and stock monitoring, while adding a Chrome Manifest V3 extension for importing product information already accessible on the Amazon page open in the user's browser.

## What changed

- Added `POST /api/browser-import` for authenticated browser-side imports.
- Added `extension/` with a Manifest V3 Amazon page parser and ELMS importer popup.
- Browser import does not perform server-side Amazon scraping or bypass CAPTCHAs/anti-bot controls.
- Existing Canopy/Rapid services remain available for variants and monitoring.

## Run

1. Copy `.env.example` if present / configure the existing ELMS environment variables.
2. Run `npm install`.
3. Run `npm start`.
4. Load `extension/` as an unpacked extension in Chrome.
5. Configure the backend URL and an ELMS session token in the extension popup.
6. Open an Amazon product page and choose **Import current Amazon product**.

The extension requires the backend CORS configuration to allow its `chrome-extension://...` origin. See `extension/README.md`.

## Testing against eBay Sandbox (no real listings)

By default ELMS talks to eBay's **production** API - a "Publish to eBay" click creates a real, live listing. To test safely instead:

1. In [developer.ebay.com](https://developer.ebay.com) > **Application Keys**, switch to the **Sandbox** tab and copy that keyset's Client ID / Client Secret / RuName (these are separate from your production keyset).
2. In [developer.ebay.com](https://developer.ebay.com) > **User Tokens** > Sandbox, register a test seller account (`TESTUSER_...`) - see [Create a test Sandbox user](https://developer.ebay.com/api-docs/static/gs_create-a-test-sandbox-user.html). No real business info is required.
3. Set these in your `.env` (or your Render environment, for a separate staging deploy):
   ```
   EBAY_ENV=sandbox
   EBAY_CLIENT_ID=<sandbox client id>
   EBAY_CLIENT_SECRET=<sandbox client secret>
   EBAY_RU_NAME=<sandbox RuName>
   ```
4. Restart the server, connect the `TESTUSER_...` sandbox account via **Connect eBay** as normal, and publish - the listing only exists in eBay's fake Sandbox marketplace, never visible to real buyers.

See `config/ebayEnvironment.js` for how this switch works. Don't mix keysets - a production Client ID/Secret will not authenticate against `EBAY_ENV=sandbox`, and a sandbox keyset will not work in production.

## Sandbox/Test Mode
Set `ELMS_TEST_MODE=true` to force ELMS to use eBay Sandbox OAuth/API endpoints. This takes precedence alongside `EBAY_ENV=sandbox` and prevents accidental Production OAuth redirects.


## Production
See `PRODUCTION-SETUP.md` before switching from Sandbox to eBay Production.

## Ultra Category + Specifications

The listing editor now separates source data from eBay listing metadata:

- **Amazon specifications (source):** the original buyer-facing specifications extracted from the Amazon product page. These remain available for editing and are never treated as eBay category metadata.
- **eBay Item Specifics — category matched:** after ELMS gets an eBay category, it calls the eBay Taxonomy API `get_item_aspects_for_category` and shows the category's required, recommended, and optional aspects.
- Amazon values are mapped into the matching eBay aspect names (for example Brand, Color/Colour, Size, Material, Model, Part Number, Country of Origin, Weight, Dimensions, etc.).
- eBay-provided allowed values are shown as dropdowns when available.
- Required aspects are marked and can be completed manually when Amazon does not contain a value.
- The selected eBay aspects are sent with publishing so the server uses the category-aware values instead of blindly sending Amazon field names as eBay aspects.

The category search is also strengthened with product title, brand, Amazon category path, breadcrumb categories, and the first product highlights instead of relying on the title alone.

The eBay Taxonomy API documentation describes this workflow: first discover a suitable leaf category with `getCategorySuggestions`, then retrieve the required/recommended/optional aspects with `getItemAspectsForCategory`.
