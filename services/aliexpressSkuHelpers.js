/**
 * Reading one AliExpress sku (an entry of aliexpress.ds.product.get's ae_item_sku_info_dtos). Shared by the stock/price monitor
 * (jobs/stockMonitor.js) and the order service (services/aliexpressOrderService.js), so both read a sku the same way.
 */

/** The sku's available stock as a number, or null when AliExpress did not give a usable one - "unknown" must never read as "0", which would end a good listing. Only a real number or a numeric string counts (Number(false), Number(' ') and Number([]) are all 0). */
function skuStock(sku) {
  const raw = sku && sku.sku_available_stock;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The sku's current price: the sale price when there is one, else the list price (the same preference services/aliexpressImportService.js normalizeAliexpressProduct imported it with). */
function skuPrice(sku) {
  const sale = Number(sku && sku.offer_sale_price);
  if (Number.isFinite(sale) && sale > 0) return sale;
  const list = Number(sku && sku.sku_price);
  return Number.isFinite(list) && list > 0 ? list : null;
}

/**
 * The sku's option string as aliexpress.ds.order.create wants it. product.get gives "73:175#Black Green;71:193#Polarized"
 * (property:value pairs with the option's NAME after a "#"); the order API's own example is just "14:70221" - so the names are
 * dropped and only the "property:value" pairs are kept, joined with ";". '' when the sku has none (a product with no options).
 */
function skuAttrForOrder(skuAttr) {
  return String(skuAttr || '')
    .split(';')
    .map((part) => part.split('#')[0].trim())
    .filter((part) => /^\d+:\d+$/.test(part))
    .join(';');
}

/**
 * Whether skuAttrForOrder keeps EVERY part of the sku's option string. A part that is not "property:value" (a text the buyer typed, a
 * format ELMS has not seen) is dropped by skuAttrForOrder - and an order sent without it would buy a DIFFERENT option of the product.
 * '' / nothing is clear (a product with no options).
 */
function skuAttrIsClear(skuAttr) {
  return String(skuAttr || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => /^\d+:\d+$/.test(part.split('#')[0].trim()));
}

/** The option's names the seller recognises ("Black Green, Polarized") - the text after each "#" of the sku's option string; '' when it has none. */
function skuAttrNames(skuAttr) {
  return String(skuAttr || '')
    .split(';')
    .map((part) => (part.includes('#') ? part.slice(part.indexOf('#') + 1).trim() : ''))
    .filter(Boolean)
    .join(', ');
}

module.exports = { skuStock, skuPrice, skuAttrForOrder, skuAttrIsClear, skuAttrNames };
