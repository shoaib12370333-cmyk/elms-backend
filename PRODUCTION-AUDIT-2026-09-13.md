# ELMS Production Audit / Fixes — 2026-09-13

## Fixed in this pass

### eBay Messages
- `GET /api/notifications` no longer calls eBay on every page load.
- Added explicit `POST /api/notifications/sync` for the Refresh button.
- Fixed eBay Message API requirement: `conversation_type` is now always sent.
- Syncs both `FROM_MEMBERS` and `FROM_EBAY` conversations.
- Corrected query parameter `conversation_status`.
- Corrected update payload to use `conversationStatus` with `ARCHIVE` (not `ARCHIVED`).
- Corrected conversation/message response mapping to current fields such as `conversationTitle`, `latestMessage`, `messageBody`, `senderUsername`, `createdDate`, and `readStatus`.
- Increased page size to the API maximum of 50 and moved upserts into parallel batches.
- Added MongoDB indexes for conversation listing/unread counts.
- Added a signed `NEW_MESSAGE` webhook endpoint at `/api/ebay/message-notification`.
- Webhook acknowledges quickly and updates the local conversation cache without blocking the eBay request.

### Orders
- Orders page no longer blocks on a live eBay sync every time the page opens.
- Background and manual syncs now use an incremental time window: 48-hour overlap after the previous sync, or the last 30 days for a first sync.
- Manual sync updates the account's last-sync timestamp.

### Backend architecture
- Backend root `/` is now a JSON health response and no longer attempts to serve a missing frontend file.
- Frontend is treated as a separate Render service.

### Frontend UX
- Messages page loads cached data immediately.
- Refresh explicitly says it is checking eBay.
- Empty inbox has a proper empty state and a Check eBay now button.
- Messages startup loads accounts, cached messages, and saved replies in parallel.
- Removed the unused Google Sign-In UI from the frontend; email/password is the active login flow.
- Added missing `terms.html`, `privacy.html`, and `user-guide.html` pages so production links do not 404.

## Important external production setup

1. Existing eBay seller connections must be re-authorized if their refresh tokens were created before the `commerce.message` scope was added.
2. Configure an eBay Notification API destination/subscription for `NEW_MESSAGE` pointing to:
   `https://<backend-domain>/api/ebay/message-notification`
3. The subscription requires the appropriate eBay notification subscription permission and the seller's authorized `commerce.message` scope as applicable to the subscription model.
4. Keep `FRONTEND_URL` pointed at the separate frontend Render service.
5. Keep `EBAY_ENV=production`, `PADDLE_ENV=production`, `ELMS_TEST_MODE=false` in the production backend.
6. Keep the existing production `ENCRYPTION_KEY`; changing it can make previously encrypted eBay credentials/extension keys unreadable.
7. Configure Namecheap SMTP for password-reset OTP mail if not already configured.

## Validation
- Backend files changed in this pass passed `node --check`.
- Frontend embedded JavaScript passed `node --check` after extraction.
- Full npm integration tests were not available in this environment; the package install timed out, so live MongoDB/eBay calls still need to be verified in Render.
