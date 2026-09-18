# ELMS Phase 3 — Stock / Quantity Safety

## Included

### 1. Conservative in-stock quantity sync
- When Canopy reports Amazon `In Stock`, ELMS synchronizes the eBay offer to quantity `1`.
- The current Canopy availability response does not expose an exact supplier quantity, so ELMS does not invent a quantity such as 5, 10, or 100.
- Quantity is only written to eBay when the listing needs a sync, reducing unnecessary listing revisions.

### 2. Safer out-of-stock handling
- When Amazon becomes `Out of Stock`, ELMS withdraws the specific eBay offer.
- The listing is marked `ended` locally only after the eBay withdrawal succeeds.
- If the eBay account/token is unavailable or withdrawal fails, the listing remains published locally so the next stock-monitor run can retry instead of creating a false local "ended" state.

### 3. eBay quantity updater
- Added `updateOfferQuantity()` to the eBay Inventory API service.
- It retrieves the current offer and preserves the existing offer fields before updating `availableQuantity`.
- Uses the listing's specific eBay account.

### 4. Stock sync state
Listings now retain:
- `amazonInStock`
- `lastStockSyncedAt`
- Existing `lastStockCheckedAt` continues to record checks.

## Price monitoring compatibility
Phase 2 fixed-dollar repricing remains unchanged. Stock/quantity synchronization runs from the same Canopy availability call and does not require a second Amazon/Canopy request.

## Important limitation
Exact supplier quantity is not implemented because the current Canopy availability response used by ELMS provides in-stock/out-of-stock state and price, but not an exact quantity. Quantity `1` is intentionally used as the conservative safe value while the source remains availability-only.
