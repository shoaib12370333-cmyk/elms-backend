# ELMS Draft Publishing Fix

## Fixed
- Draft-row Publish now always sends the currently selected sidebar eBay `accountId` to the backend.
- Bulk Publish now uses the currently selected sidebar eBay account.
- The sidebar eBay dropdown includes a `+ Add eBay account` entry for connecting another seller directly from the dropdown.
- Drafts page waits for the sidebar account selector to initialize before publishing.
- Empty draft Category ID fields automatically request an eBay Taxonomy category suggestion using the selected account marketplace, fill the top suggestion, and persist it to the draft.
- Draft detail category suggestion now uses the selected sidebar eBay account.

## Why the old error happened
The backend correctly requires an `accountId` when a user has multiple eBay accounts, but the normal Draft-row Publish handler was still calling `/api/listings/:id/publish` without a request body. With two accounts connected, the backend could not safely guess which seller to use and returned:
`Please choose which eBay account to publish to.`

## Customer Support Inbox
- Added AutoDS-style Customer Support / Messages page with multi-store filtering, search, New/Awaiting Seller/Archived views, Buyer/eBay type filters, unread badge, conversation detail, reply composer, archive/mark-unread, linked order/listing context, and ELMS-only internal notes.
- Added per-user Saved Replies/Snippets with buyer/order/product/tracking variables.
- Updated eBay Message API integration to the current `/commerce/message/v1` endpoints and current request field names.
- Added `commerce.message` OAuth scope. Existing connected eBay accounts must be re-authorized so their refresh tokens include this scope.
- Conversation polling now fetches up to 100 cached conversations per account in pages of 10.
