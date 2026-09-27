const cjAdapter = require('./cjAdapter');
const { createCjImport, updateImportImages } = require('../models/importsModel');
const { upsertCjDraft, findCjListingInStore } = require('../models/listingsModel');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { materializeImageUrls } = require('../services/imageStorageService');
const { priceByRule } = require('../services/importPricingService');
const { withCredits } = require('../services/creditService');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');

/**
 * CJdropshipping's own product+variant shape, normalized into the same "product" object saveCjProductAsDraft (and, before it,
 * priceByRule/materializeImageUrls) expects - the CJ counterpart of canopyAmazonService.normalizeProduct. Deliberately its own
 * function, not a branch of anything Amazon-facing: nothing here reads or writes an asin, an Amazon URL, or Canopy/Easyparser
 * data, and nothing Amazon-facing reads a CJ id.
 */
function normalizeCjProduct(detail, variant) {
  const images = [variant.variantImage, detail.bigImage, ...(Array.isArray(detail.productImageSet) ? detail.productImageSet : [])]
    .filter(Boolean)
    .filter((url, i, arr) => arr.indexOf(url) === i);
  const price = Number(variant.variantSellPrice);
  return {
    cjProductId: detail.pid,
    cjVariantId: variant.vid,
    variantSku: variant.variantSku,
    title: variant.variantNameEn || detail.productNameEn || detail.productSku,
    price: Number.isFinite(price) ? price : (Number(detail.sellPrice) || null),
    currency: 'USD', // every CJ price is quoted in USD (docs: "unit: $ (USD)")
    images,
    description: detail.description || '',
    inventories: Array.isArray(variant.inventories) ? variant.inventories : [],
  };
}

/** Total CJ inventory of a variant, across every warehouse country CJ reported (or just one, when a destination is known). */
function inventoryOf(product, countryCode) {
  const rows = countryCode ? product.inventories.filter((i) => i.countryCode === countryCode) : product.inventories;
  return rows.reduce((sum, i) => sum + (Number(i.totalInventory) || 0), 0);
}

/** The country CJ should ship a listing's variant to: the eBay marketplace's own country - never guessed, never an Amazon site. */
function destCountryFor(marketplaceId) {
  return getMarketplaceConfig(marketplaceId)?.country || 'US';
}

/**
 * Saves an already-fetched, normalized CJ product+variant (normalizeCjProduct above) as an import + draft listing, the CJ
 * counterpart of routes/fetchProduct.js saveProductAsDraft. Charges ACTION_COSTS.CJ_IMPORT (never AMAZON_IMPORT), refunded if
 * saving fails. The CJ shipping cost is quoted once here (services/cjAdapter.js calcFreight) and kept on the listing
 * (Listing.cjShippingCost) so it is not re-quoted on every page load; the CJ stock/price monitor refreshes it periodically.
 */
async function saveCjProductAsDraft(userId, product, markupPercent, req, knownActiveEbayAccount, { alreadyCharged = false, cost = ACTION_COSTS.CJ_IMPORT, pricingRule } = {}) {
  const activeEbayAccount = knownActiveEbayAccount !== undefined ? knownActiveEbayAccount : await getActiveEbayAccount(userId);
  const destCountry = destCountryFor(activeEbayAccount?.marketplaceId);

  const already = await findCjListingInStore(userId, product.cjProductId, product.cjVariantId, activeEbayAccount?.id || null);
  if (already) throw Object.assign(new Error('This CJ product is already in this store as a draft or a live listing.'), { statusCode: 409, alreadyListed: true });

  const ruled = await priceByRule({ userId, price: product.price, currency: product.currency, markupPercent, pricingRule });

  const save = async () => {
    let suggestedPrice = null;
    if (ruled) {
      suggestedPrice = ruled.sellPrice;
    } else if (product.price != null && markupPercent != null) {
      const markup = Number(markupPercent);
      if (!Number.isNaN(markup)) suggestedPrice = Number((product.price * (1 + markup / 100)).toFixed(2));
    }

    // A failed freight quote never blocks the import - it just leaves cjShippingCost null (profit is then shown without CJ
    // shipping until the stock/price monitor or a later import successfully quotes it).
    const freight = await cjAdapter.calcFreight(userId, { vid: product.cjVariantId, quantity: 1, endCountryCode: destCountry }).catch(() => null);

    const importRecord = await createCjImport(userId, product, suggestedPrice, activeEbayAccount?.id || null);
    const images = product.images?.length
      ? await materializeImageUrls({ urls: product.images, userId, listingId: importRecord.id, req })
      : [];
    await updateImportImages(userId, importRecord.id, images);

    const draft = await upsertCjDraft(userId, {
      importId: importRecord.id,
      ebayAccountId: activeEbayAccount?.id || null,
      marketplaceId: activeEbayAccount?.marketplaceId || null,
      cjProductId: product.cjProductId,
      cjVariantId: product.cjVariantId,
      title: product.title,
      mainImage: images[0] || null,
      images,
      sellPrice: suggestedPrice ?? product.price,
      markupPercent: ruled ? ruled.markupPercent : (Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0),
      currency: product.currency,
      quantity: 1,
      categoryId: null,
      description: product.description || '',
      bulletPoints: [],
      specifications: [],
      ebayAspects: {},
      amazonPrice: product.price,
      marginAmount: ruled ? ruled.marginAmount : (suggestedPrice != null && product.price != null ? Number((suggestedPrice - product.price).toFixed(2)) : null),
      pricingRule: ruled ? ruled.pricingRule : null,
      cjShippingCost: freight ? freight.cost : null,
    });

    return { product, suggestedPrice, importId: importRecord.id, draft, pricing: ruled ? ruled.breakdown : null, cjShipping: freight };
  };
  return alreadyCharged ? save() : withCredits(userId, cost, save);
}

/** Fetches one CJ product's detail and the ONE variant asked for (by vid, or the product's first/only variant when there is exactly one), then saves it as a draft. */
async function fetchAndSaveCjDraft(userId, { pid, productSku, variantSku, vid }, markupPercent, req, chosenStore, cost = ACTION_COSTS.CJ_IMPORT) {
  const detail = await cjAdapter.getProductDetail(userId, { pid, productSku, variantSku });
  const variant = vid ? detail.variants.find((v) => v.vid === vid) : (detail.variants.length === 1 ? detail.variants[0] : null);
  if (!variant) throw Object.assign(new Error(detail.variants.length > 1 ? 'This CJ product has several variants (colour/size ...); pick one.' : 'Could not find that CJ variant.'), { statusCode: 400, variants: detail.variants.length > 1 ? detail.variants.map((v) => ({ vid: v.vid, variantSku: v.variantSku, variantKey: v.variantKey, image: v.variantImage, price: Number(v.variantSellPrice) || null })) : undefined });

  const activeEbayAccount = chosenStore !== undefined ? chosenStore : await getActiveEbayAccount(userId);
  const product = normalizeCjProduct(detail, variant);
  return withCredits(userId, cost, () => saveCjProductAsDraft(userId, product, markupPercent, req, activeEbayAccount, { alreadyCharged: true }));
}

module.exports = { normalizeCjProduct, inventoryOf, destCountryFor, saveCjProductAsDraft, fetchAndSaveCjDraft };
