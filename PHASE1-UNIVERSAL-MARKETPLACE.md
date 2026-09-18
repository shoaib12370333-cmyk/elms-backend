# ELMS Phase 1 — Universal eBay Marketplace

## Goal
Use the existing working USA publish flow as the reference, but remove US-only assumptions from marketplace-sensitive eBay operations.

## Implemented
- Central `config/ebayMarketplaces.js` for supported eBay marketplaces.
- Marketplace ID validation before eBay connection/publish.
- Marketplace-specific currency for offers.
- Marketplace-specific locale for OAuth consent.
- Marketplace-specific `Accept-Language` and `Content-Language` on REST requests.
- `X-EBAY-C-MARKETPLACE-ID` is sent when a marketplace is known.
- Taxonomy category-tree and item-aspect requests now carry the selected marketplace and locale.
- Business-policy lookups use the selected marketplace instead of assuming US.
- Existing-offer lookup/update/publish keeps the selected marketplace throughout the publish flow.
- Price/quantity offer revisions preserve the marketplace returned by eBay.
- SKU continues to strip a legacy `AMZ-` prefix, leaving ASIN-only SKU behavior.
- Existing Edit Draft detail route and authentication/security fixes are preserved from the current backend source used for this phase.

## Supported marketplace defaults
`EBAY_US`, `EBAY_GB`, `EBAY_DE`, `EBAY_FR`, `EBAY_IT`, `EBAY_ES`, `EBAY_CA`, `EBAY_AU`, `EBAY_AT`, `EBAY_BE`, `EBAY_CH`, `EBAY_IE`, `EBAY_NL`, `EBAY_PL`, `EBAY_PH`, `EBAY_HK`, `EBAY_MY`, `EBAY_SG`, `EBAY_TW`.

Belgium and Canada expose multiple locales in eBay documentation. Phase 1 stores a default locale while retaining the supported locale list for later UI selection.

## Not changed in Phase 1
- No frontend marketplace selector redesign.
- No change to the working USA publish business rules.
- No production deployment.
- No claim that every marketplace can publish a given ASIN/category/policy combination; eBay marketplace eligibility, category, policy, and catalog availability can still vary by marketplace.
