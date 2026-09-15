# ELMS Production Setup

This build is configured to use eBay Production when `EBAY_ENV=production` (or when `EBAY_ENV` is omitted). Sandbox remains available by setting `EBAY_ENV=sandbox`.

## eBay Production

1. In the eBay Developer Portal, create/use the **Production** keyset.
2. Assign these OAuth scopes to the keyset:
   - `https://api.ebay.com/oauth/api_scope`
   - `https://api.ebay.com/oauth/api_scope/sell.inventory`
   - `https://api.ebay.com/oauth/api_scope/sell.account`
   - `https://api.ebay.com/oauth/api_scope/sell.fulfillment`
   - `https://api.ebay.com/oauth/api_scope/commerce.identity.readonly`
   - `https://api.ebay.com/oauth/api_scope/commerce.notification.subscription`
3. Configure the Production RuName's accepted-auth URL to:
   `https://YOUR-BACKEND-DOMAIN/api/ebay-connect/callback`
4. Set `EBAY_ENV=production` and use the Production Client ID, Client Secret, and RuName.
5. Reconnect every existing eBay account after changing scopes so the new consent is stored in its refresh token.

## Business Policies and location

Every live Inventory API offer needs a payment policy, fulfillment/shipping policy, return policy, and an inventory location. ELMS can fetch policies and locations from eBay in Settings. eBay requires these for publishing live offers.

## Order sync

- Polling mode: periodic Fulfillment API sync, with a configurable per-user interval.
- Real-time mode: the same polling safety net plus the signed eBay `ORDER_CONFIRMATION` webhook endpoint.
- The webhook endpoint is `/api/ebay-order-notification` (check `server.js` mounting). Configure the public HTTPS endpoint and verification token in environment variables.
- eBay user-based notification subscriptions require the notification subscription OAuth scope and a public HTTPS endpoint. The actual eBay subscription still needs to be created/enabled in eBay's Notification API/developer workflow unless an approved subscription-management workflow is added.

## Tracking conversion

`POST /api/orders/tracking/convert` normalizes common carrier names into eBay carrier codes. When tracking is saved through `PUT /api/orders/:id/tracking`, ELMS converts the carrier and sends the fulfillment update to eBay.

## Auto Order limitation

The Auto Order credit/feature label is retained, but this build does **not** pretend to place retail Amazon purchases automatically. Amazon's public seller APIs are not a generic retail checkout API for buying arbitrary Amazon retail products for eBay customers. A real unattended procurement implementation requires a supported supplier/retail ordering integration (with the required account authorization and terms). ELMS therefore keeps this part fail-closed rather than using browser automation, CAPTCHA bypasses, or fake order IDs.

## Security before going live

- Replace `ENCRYPTION_KEY` with a long random secret.
- Replace `JWT_SECRET` with a long random secret.
- Rotate any credential that was ever pasted into chat/screenshots.
- Use HTTPS only for `FRONTEND_URL`, RuName callback URLs, and notification endpoints.
- Do not commit `.env`.
