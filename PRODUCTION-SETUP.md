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
- Real-time mode (free, no daily credit fee): the same polling safety net plus the signed eBay `ORDER_CONFIRMATION` webhook endpoint. Only the polling-only mode is charged (`ORDER_SYNC_POLLING_DAILY`).
- The webhook endpoints (mounted in `server.js`) are `/api/ebay/order-notification` (ORDER_CONFIRMATION), `/api/ebay/message-notification` (NEW_MESSAGE) and `/api/ebay/account-deletion` (Marketplace Account Deletion, required by eBay). Each one answers eBay's `challenge_code` check with SHA-256(challenge code + verification token + the exact public endpoint URL), and each needs its own two environment variables: `EBAY_ORDER_NOTIFICATION_VERIFICATION_TOKEN` + `EBAY_ORDER_NOTIFICATION_ENDPOINT_URL`, `EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN` + `EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL`, `EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN` + `EBAY_ACCOUNT_DELETION_ENDPOINT_URL`. Without them eBay cannot verify the endpoint (a GET with a `challenge_code` answers 500 and says which variable is missing).
- Until the order-notification variables are set AND eBay has a subscription for the seller, there is no live order feed: "real-time" users are then synced by the safety-net poll at their chosen interval (still free).
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

## Visitor IP address

On Render a request travels visitor -> Cloudflare -> Render's proxy -> ELMS. `config/trustProxy.js` skips Cloudflare's published address ranges (and internal addresses) so `req.ip` is the visitor; the IP limits, IP blocks, the new-accounts-per-network guard and the sign-in location depend on it. After a deploy, sign in once from your own phone and check that Settings -> Security shows YOUR public IP (not a `172.6x`, `104.x` or `162.158.x` Cloudflare address). If it still shows a Cloudflare address, set `TRUST_PROXY_HOPS=2` on Render (a fixed hop count) and tell us. An IP you blocked earlier that was really a Cloudflare address no longer matches anyone: remove it in the admin panel.

## Sign-up email checks

`POST /api/auth/register` refuses example/test addresses, temporary-mail services (built-in list; add more with `BLOCKED_EMAIL_DOMAINS=a.com,b.net`), typos of the big providers and domains without mail (DNS lookup; a slow or failing lookup lets the sign-up through).

## Sign-up confirmation code

Sign-up with a password is two steps: `POST /api/auth/register` mails a 6-digit code (valid 15 minutes, 5 tries, a new code at most once a minute, at most 5 sign-ups per address per hour) and remembers the sign-up in `PendingSignup` (it disappears by itself after 24 h); no account exists yet. `POST /api/auth/register/confirm` with the code and the browser's `pendingToken` makes the account, gives the welcome credits, mails the welcome mail and signs the person in. So password sign-up needs a working SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`), the same as "Forgot password"; Google sign-up does not. Accounts from before this change are untouched.
