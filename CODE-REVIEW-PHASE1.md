# Phase 1 Code Review

## Review scope
Reviewed the backend source used as the Phase 1 base plus the marketplace changes in this phase.

## Findings and actions

### 1. US-only locale headers
**Finding:** The publish request helper used `en-US` for every marketplace.
**Action:** Locale now comes from the central marketplace configuration, and `Accept-Language`/`Content-Language` follow the selected marketplace.

### 2. Marketplace identity was spread across the code
**Finding:** Marketplace IDs, currencies, and OAuth locales were duplicated in different files.
**Action:** Centralized marketplace configuration and reused it from OAuth connection and listing services.

### 3. Publish currency could remain USD
**Finding:** A non-US offer could fall back to USD.
**Action:** Publish uses the selected marketplace's configured currency and rejects unsupported marketplace IDs before publishing.

### 4. Taxonomy calls did not carry locale/marketplace headers
**Finding:** Category tree IDs were selected by marketplace query, but request headers were not marketplace-aware.
**Action:** Taxonomy requests now include marketplace and locale headers.

### 5. Business policy lookups could default to US language
**Finding:** Policy calls used the marketplace query but the generic request helper had no selected marketplace context.
**Action:** Policy calls now pass the selected marketplace through the request helper.

### 6. Existing offer updates
**Finding:** Price/quantity revisions loaded an offer correctly but did not explicitly pass its marketplace back through the update request.
**Action:** Update requests now reuse the marketplace returned by eBay.

### 7. Regression protection
**Finding:** Earlier fixes existed in separate backend ZIPs, creating a risk that deploying a later ZIP would overwrite them.
**Action:** Phase 1 preserves the current Edit Draft route and the latest Google/password/OTP security changes from the auth-security backend.

## Verification performed
- Node syntax check across all backend JavaScript files: PASS.
- Marketplace configuration tests: PASS.
- Unsupported marketplace validation test: PASS.
- Case/whitespace normalization test: PASS.
- Marketplace currency/locale matrix test: PASS.

## Remaining integration checks
Real eBay publish tests still require a connected eBay account and the appropriate Sandbox or Production credentials. This package has not been deployed or claimed as production-verified.
