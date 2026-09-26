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

## eBay call budget (many stores)

eBay gives the whole application a fixed number of Trading API calls per day (5,000 by default, shared by every seller). Views and watchers are the only thing read again and again, so `services/ebayCallBudget.js` keeps a daily count in MongoDB (`ApiUsage`, one row per Pacific-time day) and gives statistics 70% of it; order pictures, buyer profiles and the connect step are counted but never refused. A store is read with `GetMyeBaySelling` (200 listings per eBay call), never one call per listing. When the day's share is used up the background job (`jobs/statsSync.js`, every 30 minutes) stops and the Live listings page keeps showing the last numbers; stores whose owner has not opened ELMS for 14 days are skipped until they come back. Opening the page or pressing the sync button asks eBay at most once every 2 minutes per store.

Set `EBAY_TRADING_DAILY_LIMIT` (default 5000) when eBay raises your limit (Application Growth Check) and `EBAY_TRADING_STATS_SHARE` (0.1-1, default 0.7) to change the share. Admin -> `GET /api/admin/ebay-usage` shows today's numbers and what the last run did (`viewsInBulk: false` means eBay's bulk answer has no view counts, so views are refreshed a few listings at a time instead).

## More eBay reads (selling limit, listing problems, usage)

Three read-only eBay APIs feed the panels; none of them needs a new permission or a reconnect. **Selling limit** (Account API `getPrivileges`) and **listings that break an eBay rule** (Compliance API, e.g. missing item specifics) are asked with the seller's own token, remembered for 30 minutes and shown under each store in Settings (`GET /api/ebay-accounts/:id/status`, `/violations?type=`) and as a banner on Live listings. If eBay answers 401/403 for a store (connected before the permission existed, or the Compliance API is not open to the app) the store just shows "eBay status not available". **eBay API usage** (Analytics `getRateLimits`, with the application token) is in Admin -> Settings next to ELMS's own Trading count; the app needs its normal `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`.

## Pricing rule (Settings > Pricing)

A seller can save one pricing rule (`GET/PUT /api/pricing/rule`, `POST /api/pricing/preview`): fees % and fixed fee, profit % and fixed profit, a minimum profit, an amount for shipping, the cents the price must end in and cost-range ("dynamic") profit tiers. The price is `(cost x (1 + profit%) + fixed profit + fixed fee) / (1 - fees%)`, in whole cents (`services/pricingService.js`; the same maths as the Price Calculator).

It prices a product **only when it is switched on and the request has no markup % of its own**: the single import, the extension's import and the background list. A markup typed on the Import page (or sent by an older extension) always wins and works exactly as before; with no rule, or a rule that is off, nothing changes. A rule that cannot be used (a broken saved rule, or a rule in another currency with no exchange rate right now) refuses the import (409 / 503) before any credit is taken. A background list keeps the rule of the moment it started (`BulkImportJob.pricingRule`). A draft keeps a copy of its rule (`Listing.pricingRule`, money in the listing's currency): the stock monitor then re-prices it by the rule instead of keeping the cash margin, and a price typed by hand ends the rule for that listing. Existing drafts and live listings are never touched by saving a rule.


## Suspend, permanent ban, appeals and account mails

Admin -> Users -> Security: **Suspend** (the person can appeal from the blocked screen) or **Permanent ban** (`permanent: true`: no appeal, `POST /api/appeals` answers 403 for that account). Both mail the person the reason; **reinstating** mails them too. A permanent ban can only be reinstated with a message of 10+ characters (checked on the server), and that message goes into the mail. The mails go out from the **Security** sender (`SMTP_FROM_SECURITY`, or the default sender when it is not set up), replies go to Support. If the mail cannot be sent, the action still happens and the admin is told ("the email could not be sent").

Appeals are support tickets with source `appeal`. **Admin -> Appeals** lists them (open first, with the state of the account); a person who already has an open appeal adds to it instead of opening another. Reinstating an account closes its open appeals.

Every ELMS mail carries the same layout and the Privacy Policy / Terms links (`/privacy`, `/terms`): `mailTemplate.ensureLayout` runs on every message inside `emailService.sendWithTimeout`, so a mail written without the layout still gets it, and `tests/banAppeals.test.js` fails if a new `send...` function has no sample there.

## Large imports (bulk jobs) and the Easyparser per-minute limit

A background list can hold up to **2500 links** (Admin -> Limits -> `bulkJobMax`; 2500 is the highest it can be set to and the default; a lower value saved earlier stays until you change it). The processor runs once a minute and, per job, sends at most 90% of the plan's per-minute limit to Easyparser and reads and saves at most the limit's worth of finished products (`EASYPARSER_PER_MINUTE`, default 500 = our plan). Sending everything at once made Easyparser answer "rate limit" for all but the first 500, and the rest were given up on after 5 tries; now a run that got anything through does not count as a failed attempt. 2500 links take about 6 runs (about 6 minutes plus Easyparser's own time); set `EASYPARSER_PER_MINUTE` if the plan changes.

## Publish all (batches), notifications and how many publish at once

`POST /api/listings/publish-batch { ids }` starts a whole selection in ONE request (up to 2000): every draft is claimed and put in line for the background publisher and the answer comes at once (202, with `started` and the reason for each one that was not started). `GET /api/listings/publish-batch/:id` gives the counts (published / failed / still publishing). When every listing of a batch has finished, the person gets ONE notification in the bell (also with the page closed): how many went live and how many failed (the once-a-minute publish job sends it; it is marked atomically, so it is never sent twice).

`PUBLISH_CONCURRENCY` (default 6, or 30 with bulk publishing on; at most 50): how many publishes run at the same time for the whole server. eBay answers "system error" when it is hit with too many at once, so raise it slowly and watch the failed count. A listing that is waiting in the server's line is never failed as "interrupted" any more (that used to happen after 30 minutes for the ones at the back of a long list); only a listing that nothing is working on and nothing is waiting for is.

## eBay bulk publishing (`EBAY_BULK_PUBLISH`)

One listing published the old way is four eBay calls (inventory item, look for an offer, create offer, publish). eBay's Inventory API takes **25 of each step in one call** (`bulk_create_or_replace_inventory_item`, `bulk_create_offer`, `bulk_publish_offer`), so 1000 listings are about 120 calls instead of about 4000. With `EBAY_BULK_PUBLISH=1` the publish worker sends the first attempt of each listing through `services/ebayBulkPublisher.js`: listings that ask at about the same time (same eBay store and marketplace) are collected for a moment (`BULK_PUBLISH_WINDOW_MS`, default 1500) or until 25 are there, and go together. The worker itself is unchanged (credits, checks, refunds, notifications); it only runs more listings at the same time (`PUBLISH_CONCURRENCY`, default 30 when bulk is on, at most 50).

**Off by default.** The shapes of the three calls follow eBay's Inventory API model documentation, but they have not been run against a real store from here. Turn it on like this: 1) set `EBAY_BULK_PUBLISH=1` on the backend, 2) publish 3 to 5 drafts of ONE store, 3) look at the Render log for `[bulk-publish] group of N: ...` and check the listings are live on eBay, 4) then publish a bigger selection. Set it back to `0` (or remove it) to return to the old way at once.

Safety: whenever anything is unusual, that listing goes the ordinary one-at-a-time way, which already reuses an existing offer: a bulk call that fails as a whole (timeout, 5xx, 429, an answer that cannot be read), an offer that already exists, an answer that is missing for a listing, or the same SKU twice in one group. A listing eBay really refuses (a missing item specific ...) fails with eBay's own words, as before. A retry after a transient eBay error is always one listing on its own.

## Live listings: Change price (many at once)

`POST /api/listings/bulk-live-price { ids, changes: { price: { mode: 'saved' | 'custom', rule } } }` (up to 500 per request; the page sends 100 at a time, three requests at once). The new price of each LIVE listing is worked out from its own Amazon price by the pricing rule (the same code as the Drafts bulk edit) and sent to eBay with `bulk_update_price_quantity`: **25 prices per call, four calls at a time** (`services/liveBulkPriceService.js`), so 1000 listings are about 40 eBay calls. Only after eBay took a price does ELMS save its copy (with the rule, so the price monitor keeps using it). Anything unusual (the whole call fails, an offer is missing from the answer, an offer is refused) sends that listing the ordinary way (`updateOfferPrice`), which sets the price or fails with eBay's own words; that listing is then reported as skipped with the reason. No flag: the fallback makes a wrong call shape slow, never wrong. The Render log shows `[bulk-price] N prices for eBay in G group(s): X in bulk, Y one by one, Z refused.`; if `in bulk` is 0 on a big run, the bulk call itself is being refused and only the slow path is working.

## "The UPC field is missing" (eBay error 25002)

Some eBay categories want a barcode (UPC / EAN / ISBN); ELMS has none for an Amazon product. Nothing is sent for a barcode by default, so a listing that publishes fine is left exactly as it was. When eBay answers that an identifier is missing ("The UPC field is missing. Please add UPC to the listing and try again."), that one listing is published once more, at once, with `product.upc` (or `ean` / `isbn`, whichever eBay named) = `["Does not apply"]`, eBay's text for a product without a barcode (`services/productIdentifiers.js`, used by `publishOnEbay`; it works for the bulk and the ordinary path). If eBay still refuses, its own message is shown on the draft as before (for example that the barcode itself is not valid): that category then needs a real barcode. Listings that already failed with this message go through again with **Retry**.
