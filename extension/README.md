# ELMS Amazon Importer 2.1

The extension now works as a **one-time connection + floating import button**.

## User flow
1. Open the ELMS dashboard and copy the user's **ELMS Extension Key**.
2. Open the extension once and click **Connect ELMS Account**.
3. After connection, the extension remembers the ELMS session locally.
4. The popup does not need to be opened for every product.
5. On supported Amazon pages, a small **ELMS logo button** appears in the bottom-right corner.
6. Click the logo to read the current Amazon product and save it directly to ELMS Drafts.
7. If the page is not an Amazon product page, the logo shows an error instead of importing anything.

## Re-authentication
The background service automatically exchanges the saved Extension Key for a fresh session when there is no session token or when ELMS returns HTTP 401.

## Development
The backend URL can still be configured from the popup. In production, the backend's Admin Panel controls which Chrome extension ID is allowed by CORS.


CORS note: Chrome extension origins are allowed to bootstrap in development and production; ELMS Extension Key/session authentication remains required for protected API actions.


### Extraction guarantees
- Title prefers Amazon's dedicated product-title nodes and rejects generic accessibility/keyboard shortcut text.
- Description uses dedicated product-description nodes first, then JSON-LD, then a clean bullet fallback.
- Item specifications exclude Amazon source metadata such as ASIN, BSR, reviews, manufacturer and availability.
- Images are restricted to the current product gallery and structured product-image data.
