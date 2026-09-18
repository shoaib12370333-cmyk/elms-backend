# ELMS Phase 1 Backend Fixes

## Draft save -> publish consistency
- Added draft snapshot fields to the Listing model for description, bullet points, specifications, and eBay item specifics.
- Edit Draft saves those values into the listing itself.
- The linked Amazon import is still synchronized for editor/history compatibility.
- Publish now uses the saved listing snapshot first, with the import as a fallback for older drafts.
- This prevents a later Amazon/source refresh from silently changing a seller's saved draft before publish.

## eBay item specifics
- The eBay publishing service caps item-specific names at 45 before sending the Inventory API request.
- Duplicate aspect names are removed case-insensitively.
- Aspect values are trimmed and limited to eBay's standard 65-character value length.

## Existing publish queue fix retained
- `processOneQueuedListing` remains exported and is imported by the listing publish route, fixing the earlier `ReferenceError` seen in Render logs.

## Compatibility
- Existing Listing documents do not require a migration. New snapshot fields use safe defaults and older drafts continue using their linked Import product as fallback data.
