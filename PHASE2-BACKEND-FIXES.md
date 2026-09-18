# ELMS Phase 2 Backend Fixes

## Fixed-margin repricing
- Added per-listing Amazon/source price snapshot (`amazonPrice`).
- Added fixed cash margin (`marginAmount`) and `repricingEnabled`.
- New drafts initialize margin from sell price minus source price.
- Published listings preserve the same dollar margin when source price changes.
- Example: source $100 / eBay $110 -> source $110 / eBay $120.

## Reliable price monitoring
- Listing `amazonPrice` is now the repricing baseline instead of the mutable Import record.
- Baseline advances only after eBay accepts the new price.
- If eBay rejects/times out, the old baseline remains so the next scheduled run can retry.
- Import price is still refreshed for UI/history, but it is not the repricing baseline.
- Repricing can be disabled per listing at the backend level.

## Draft/source refresh protection
- Once a seller explicitly saves a draft, automatic source refreshes no longer overwrite seller-edited fields.
- Source price metadata can still refresh for monitoring.

## Compatibility
- Existing listings without `amazonPrice`/`marginAmount` fall back to sell-price-minus-source-price on the first repricing event.
- Existing `markupPercent` remains intact for the current UI and legacy drafts.
