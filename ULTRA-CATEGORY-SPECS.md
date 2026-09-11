# ELMS Ultra Category + Amazon Specifications

## Where Amazon specifications go

Amazon source specifications are displayed under:

**Amazon specifications (source)**

They remain separate from eBay metadata so ELMS does not confuse Amazon's field names with eBay's category-specific item specifics.

## Where eBay specifications go

After a category is selected, ELMS loads:

**eBay Item Specifics — category matched**

This section is populated from eBay Taxonomy metadata for the selected leaf category.

### Flow

Amazon product
→ title/brand/category/bullets used for category search
→ eBay category suggestion
→ eBay category ID
→ eBay Taxonomy `get_item_aspects_for_category`
→ required/recommended/optional eBay aspects
→ Amazon values mapped into matching eBay aspects
→ seller can edit/complete values
→ selected aspects sent during eBay publish

## Important

The category metadata is marketplace-specific. ELMS uses the connected account's marketplace (default `EBAY_US`).
