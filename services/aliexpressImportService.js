const aliexpressAdapter = require('./aliexpressAdapter');
const { createAliexpressImport, updateImportImages } = require('../models/importsModel');
const { upsertAliexpressDraft, findAliexpressListingInStore } = require('../models/listingsModel');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { materializeImageUrls } = require('../services/imageStorageService');
const { priceByRule } = require('../services/importPricingService');
const { withCredits } = require('../services/creditService');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');

/** A pasted AliExpress product URL (e.g. https://www.aliexpress.com/item/1005003784285827.html) or a bare numeric id. */
function extractAliexpressProductId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const match = raw.match(/\/item\/(\d+)(?:\.html|[/?]|$)/i) || raw.match(/[?&]productId=(\d+)/i) || raw.match(/(\d{9,})/);
  return match ? match[1] : null;
}

/** The eBay marketplace's own country - AliExpress needs this to price/quote the product for (docs: price varies by ship_to_country). */
function destCountryFor(marketplaceId) {
  return getMarketplaceConfig(marketplaceId)?.country || 'US';
}

/** One sku's picker-friendly label from its ae_sku_property_dtos, e.g. "Black Green / Polarized". */
function skuLabel(sku) {
  const props = Array.isArray(sku.ae_sku_property_dtos) ? sku.ae_sku_property_dtos : [];
  return props.map((p) => p.property_value_definition_name || p.sku_property_value).filter(Boolean).join(' / ') || null;
}

/** Every sku of an AliExpress product detail (aliexpressAdapter.getProductDetail), picker-shaped - the AliExpress counterpart of cjAdapter's variant list in routes/cj.js. */
function listSkus(detail) {
  const skus = Array.isArray(detail.ae_item_sku_info_dtos) ? detail.ae_item_sku_info_dtos : [];
  return skus.map((s) => ({
    skuId: s.sku_id,
    label: skuLabel(s),
    image: s.ae_sku_property_dtos?.find((p) => p.sku_image)?.sku_image || null,
    price: Number(s.offer_sale_price) || Number(s.sku_price) || null,
    inventory: Number(s.sku_available_stock) || 0,
  }));
}

/**
 * AliExpress's own product+sku shape, normalized into the same "product" object saveAliexpressProductAsDraft (and, before
 * it, priceByRule/materializeImageUrls) expects - the AliExpress counterpart of cjImportService.js normalizeCjProduct.
 * Deliberately its own function: nothing here reads or writes an asin, a CJ id, or Canopy/Easyparser data.
 */
function normalizeAliexpressProduct(detail, sku) {
  const base = detail.ae_item_base_info_dto || {};
  const gallery = String(detail.ae_multimedia_info_dto?.image_urls || '').split(';').map((s) => s.trim()).filter(Boolean);
  const skuImage = sku.ae_sku_property_dtos?.find((p) => p.sku_image)?.sku_image || null;
  const images = [skuImage, ...gallery].filter(Boolean).filter((url, i, arr) => arr.indexOf(url) === i);
  const brand = (Array.isArray(detail.ae_item_properties) ? detail.ae_item_properties : []).find((p) => /brand/i.test(p.attr_name || ''))?.attr_value || null;
  const price = Number(sku.offer_sale_price);
  return {
    aliexpressProductId: String(base.product_id || detail.product_id_converter_result?.main_product_id || ''),
    aliexpressSkuId: String(sku.sku_id),
    title: [base.subject, skuLabel(sku)].filter(Boolean).join(' - ') || base.subject || null,
    price: Number.isFinite(price) ? price : (Number(sku.sku_price) || null),
    currency: sku.currency_code || base.currency_code || 'USD',
    images,
    description: base.detail || base.mobile_detail || '',
    brand,
    inventory: Number(sku.sku_available_stock) || 0,
  };
}

/**
 * Saves an already-fetched, normalized AliExpress product+sku (normalizeAliexpressProduct above) as an import + draft
 * listing, the AliExpress counterpart of cjImportService.js saveCjProductAsDraft / routes/fetchProduct.js
 * saveProductAsDraft. Charges ACTION_COSTS.ALIEXPRESS_IMPORT (never AMAZON_IMPORT or CJ_IMPORT), refunded if saving fails.
 */
async function saveAliexpressProductAsDraft(userId, product, markupPercent, req, knownActiveEbayAccount, { alreadyCharged = false, cost = ACTION_COSTS.ALIEXPRESS_IMPORT, pricingRule } = {}) {
  const activeEbayAccount = knownActiveEbayAccount !== undefined ? knownActiveEbayAccount : await getActiveEbayAccount(userId);

  const already = await findAliexpressListingInStore(userId, product.aliexpressProductId, product.aliexpressSkuId, activeEbayAccount?.id || null);
  if (already) throw Object.assign(new Error('This AliExpress product is already in this store as a draft or a live listing.'), { statusCode: 409, alreadyListed: true });

  const ruled = await priceByRule({ userId, price: product.price, currency: product.currency, markupPercent, pricingRule });

  const save = async () => {
    let suggestedPrice = null;
    if (ruled) {
      suggestedPrice = ruled.sellPrice;
    } else if (product.price != null && markupPercent != null) {
      const markup = Number(markupPercent);
      if (!Number.isNaN(markup)) suggestedPrice = Number((product.price * (1 + markup / 100)).toFixed(2));
    }

    const importRecord = await createAliexpressImport(userId, product, suggestedPrice, activeEbayAccount?.id || null);
    const images = product.images?.length
      ? await materializeImageUrls({ urls: product.images, userId, listingId: importRecord.id, req })
      : [];
    await updateImportImages(userId, importRecord.id, images);

    const draft = await upsertAliexpressDraft(userId, {
      importId: importRecord.id,
      ebayAccountId: activeEbayAccount?.id || null,
      marketplaceId: activeEbayAccount?.marketplaceId || null,
      aliexpressProductId: product.aliexpressProductId,
      aliexpressSkuId: product.aliexpressSkuId,
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
    });

    return { product, suggestedPrice, importId: importRecord.id, draft, pricing: ruled ? ruled.breakdown : null };
  };
  return alreadyCharged ? save() : withCredits(userId, cost, save);
}

/** Fetches one AliExpress product's detail and the ONE sku asked for (by skuId, or the product's first/only sku when there is exactly one), then saves it as a draft. */
async function fetchAndSaveAliexpressDraft(userId, { productId, skuId }, markupPercent, req, chosenStore, cost = ACTION_COSTS.ALIEXPRESS_IMPORT) {
  const activeEbayAccount = chosenStore !== undefined ? chosenStore : await getActiveEbayAccount(userId);
  const detail = await aliexpressAdapter.getProductDetail(userId, { productId, shipToCountry: destCountryFor(activeEbayAccount?.marketplaceId) });
  const skus = Array.isArray(detail.ae_item_sku_info_dtos) ? detail.ae_item_sku_info_dtos : [];
  const sku = skuId ? skus.find((s) => String(s.sku_id) === String(skuId)) : (skus.length === 1 ? skus[0] : null);
  if (!sku) throw Object.assign(new Error(skus.length > 1 ? 'This AliExpress product has several options (colour/size ...); pick one.' : 'Could not find that AliExpress sku.'), { statusCode: 400, skus: skus.length > 1 ? listSkus(detail) : undefined });

  const product = normalizeAliexpressProduct(detail, sku);
  return withCredits(userId, cost, () => saveAliexpressProductAsDraft(userId, product, markupPercent, req, activeEbayAccount, { alreadyCharged: true }));
}

module.exports = { extractAliexpressProductId, destCountryFor, listSkus, normalizeAliexpressProduct, saveAliexpressProductAsDraft, fetchAndSaveAliexpressDraft };
