# Phase 4 Backend Ready

Implemented without requiring an Amazon buyer-account connection:

- Auto Order preference: Disabled / Semi-Auto / Full-Auto.
- Full-Auto requires explicit confirmation and is execution-blocked until a supported buyer-account adapter exists.
- Semi-Auto Amazon order linking endpoint.
- Processing-orders endpoint for seller action queue.
- eBay fulfillment/payment/cancel status snapshots on order lines.
- Historical order profit prefers the Listing Amazon-price snapshot instead of a mutable import price.
- Existing stock monitoring, fixed-margin repricing, draft protection, eBay notifications, message sync, scheduled publishing, and publish queue remain intact.

Not implemented because external buyer credentials/adapter are required: automatic Amazon retail checkout and automatic retrieval of Amazon buyer-order tracking.
