# ELMS 2.0 — Browser Import Build

This package combines the ELMS backend with the upgraded frontend and Amazon browser importer.

## Structure

- `frontend/` — ELMS web application
- `backend/` — Node/Express API
- `backend/extension/` — Chrome extension for browser-side Amazon product import

## Import architecture

1. User opens an Amazon product page.
2. ELMS Extension extracts accessible page data (ASIN, title, price, images, bullets, specs, etc.).
3. Extension sends the normalized product to `POST /api/browser-import`.
4. Backend validates and saves the import/draft.
5. Canopy/Rapid remain available for API-backed variant/detail/monitoring operations.

## Important

The extension does not attempt to bypass CAPTCHAs, anti-bot controls, login walls, or other access restrictions. It reads data available on the currently open page.

## Run

### Backend
See `backend/README.md` and `.env.example` for environment configuration.

### Frontend
Serve `frontend/` from the configured frontend origin.

### Chrome extension
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose "Load unpacked".
4. Select `backend/extension/`.
5. Open the extension popup and configure the ELMS backend URL and session token.

Never publish a real session token or API key inside the extension source.


## Personal Extension Key
Each ELMS user now gets a unique Extension Key in **Settings → Browser Extension**. The key can be pasted into the Chrome extension on any device. The extension exchanges it for a normal ELMS session token and sends browser-extracted Amazon products to the authenticated user's Drafts. Regenerating the key immediately invalidates the previous key.

## Production security notes

- Set `NODE_ENV=production` in production.
- Set `ELMS_EXTENSION_ID` to the exact published Chrome extension ID. In production, arbitrary `chrome-extension://` origins are not allowed by CORS.
- The manual stock-check endpoint is admin-only and rate-limited.
- eBay Marketplace Account Deletion notifications are signature-verified before any eBay account data is deleted.
- eBay publishing uses the server-stored Amazon Import as the source of truth rather than accepting arbitrary client product payloads.

## Sandbox webhook behavior
When `EBAY_ENV=sandbox` or `ELMS_TEST_MODE=true`, the Marketplace Account Deletion
endpoint acknowledges incoming callbacks without attempting Production public-key
verification. This prevents Production eBay deletion notifications configured on a
shared callback URL from being rejected with a Sandbox public-key 404 during tests.
Production deployments continue to verify the `X-EBAY-SIGNATURE` normally.

