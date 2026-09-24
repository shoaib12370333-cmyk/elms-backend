(() => {
  if (window.__elmsImporterLoadedV2) return;
  window.__elmsImporterLoadedV2 = true;

  const clean = (value, max = 20000) => {
    if (value == null) return null;
    const v = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return v ? v.slice(0, max) : null;
  };
  const text = (el, max = 20000) => clean(el?.textContent, max);
  const unique = (arr) => [...new Set(arr.filter(Boolean))];
  const absolute = (url) => { try { return new URL(url, location.href).href; } catch (_) { return null; } };

  function getAsin() {
    const candidates = [
      document.querySelector('meta[name="ASIN"]')?.content,
      document.querySelector('input[name="ASIN"]')?.value,
      document.querySelector('#ASIN')?.value,
      document.querySelector('[data-asin]')?.getAttribute('data-asin'),
      location.pathname.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i)?.[1]
    ];
    const found = candidates.find(v => /^[A-Z0-9]{10}$/i.test(String(v || '').trim()));
    return found ? String(found).trim().toUpperCase() : null;
  }

  function getJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        const product = nodes.find(x => x && (x['@type'] === 'Product' || (Array.isArray(x['@type']) && x['@type'].includes('Product'))));
        if (product) return product;
      } catch (_) {}
    }
    return {};
  }

  function parsePrice(value) {
    if (value == null) return null;
    let s = String(value).replace(/[^0-9.,-]/g, '').trim();
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',') && /,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // The currency an Amazon site shows its prices in (the site is more reliable than the page language or a default).
  const HOST_CURRENCY = { com: 'USD', 'co.uk': 'GBP', ca: 'CAD', 'com.au': 'AUD', de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR', be: 'EUR', ie: 'EUR', pl: 'PLN', se: 'SEK', in: 'INR', 'co.jp': 'JPY', 'com.mx': 'MXN', 'com.br': 'BRL', sg: 'SGD', ae: 'AED', sa: 'SAR', 'com.tr': 'TRY', eg: 'EGP' };
  function currencyForHost(host) {
    const m = String(host || '').toLowerCase().match(/(?:^|\.)amazon\.([a-z.]+)$/);
    return (m && HOST_CURRENCY[m[1]]) || null;
  }

  const PRODUCT_INFORMATION_NAMES = new Set([
    'asin', 'date first available', 'manufacturer', 'department', 'best sellers rank',
    'customer reviews', 'customer review', 'upc', 'ean', 'isbn'
  ]);

  const EBAY_SPEC_HINTS = /^(brand|colour|color|ear placement|form factor|impedance|noise control|sensitivity|headphone jack|connectivity|connectivity technology|material|size|model name|model|compatible brand|compatible model|wireless technology|bluetooth|battery life|microphone type|frequency response|driver size|cable length|water resistance|waterproof|audio format|type|style|pattern|theme|occasion|department|character|character family|age level|recommended age range|number of players|power source|voltage|wattage|assembly required|features|finish|shape|capacity|dimensions|weight|item height|item width|item length|mounting type|installation type|compatible device|included components|country of origin|color family)$/i;

  function cleanHighlight(value) {
    const v = clean(value, 1800);
    if (!v) return null;
    // Normalize Amazon's shouting-style bullet headings while keeping the
    // underlying factual content intact.
    const m = v.match(/^([^:]{2,90}):\s*(.+)$/);
    if (m) {
      const heading = m[1].toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
      return `${heading}: ${m[2].trim()}`.slice(0, 900);
    }
    return v.slice(0, 900);
  }

  function normalizeSpecName(name) {
    return clean(name, 300)?.replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim() || null;
  }

  function addSpec(list, name, value) {
    const n = normalizeSpecName(name);
    const v = clean(value, 2000);
    if (!n || !v || n.length > 120) return;
    if (/^(name|value|technical details|product information|item specifications?)$/i.test(n)) return;
    if (PRODUCT_INFORMATION_NAMES.has(n.toLowerCase())) return;
    // Never accept obvious script/CSS/HTML leakage as a specification value.
    if (/\b(function\s*\(|P\.when\(|window\.|document\.|var\s+dp|\.aplus-v2|\{\s*position:)/i.test(v)) return;
    const key = `${n.toLowerCase()}\u0000${v.toLowerCase()}`;
    if (!list.some(x => `${x.name.toLowerCase()}\u0000${x.value.toLowerCase()}` === key)) {
      list.push({ name: n, value: v });
    }
  }

  function collectItemSpecifications() {
    const specs = [];
    const roots = [];
    const addRoot = (el) => { if (el && !roots.includes(el)) roots.push(el); };

    // Dedicated specification/product-overview areas used by different Amazon layouts.
    document.querySelectorAll([
      '#productOverview_feature_div',
      '#productOverview',
      '#productDetails',
      '#productDetails_techSpec_section_1',
      '#productDetails_techSpec_section_2',
      '#technicalSpecifications_section_1',
      '#technicalSpecifications_section_2',
      '[data-feature-name="productOverview"]',
      '[data-feature-name="technicalSpecifications"]',
      '[data-feature-name="productDetails"]',
      '#poExpander',
      '#productOverview_feature_div table',
      '#productDetails_feature_div',
      '#detailBullets_feature_div'
    ].join(',')).forEach(addRoot);

    const parseRow = (row) => {
      const cells = [...row.querySelectorAll(':scope > th, :scope > td')]
        .map(cell => clean(cell.textContent, 2000))
        .filter(Boolean);
      if (cells.length >= 2) {
        addSpec(specs, cells[0], cells.slice(1).join(' '));
        return;
      }
      // Some newer layouts use div/span pairs instead of table cells.
      const labels = [...row.querySelectorAll(':scope dt, :scope .a-text-bold, :scope [class*="label"]')]
        .map(el => clean(el.textContent, 500)).filter(Boolean);
      const values = [...row.querySelectorAll(':scope dd, :scope .a-text-normal, :scope [class*="value"]')]
        .map(el => clean(el.textContent, 1500)).filter(Boolean);
      if (labels.length && values.length) addSpec(specs, labels[0], values[0]);
    };

    roots.forEach(root => {
      root.querySelectorAll('tr').forEach(parseRow);
      root.querySelectorAll('dl').forEach(dl => {
        const dts = [...dl.querySelectorAll(':scope > dt')];
        dts.forEach(dt => {
          const dd = dt.nextElementSibling;
          if (dd && dd.matches('dd')) addSpec(specs, dt.textContent, dd.textContent);
        });
      });
      root.querySelectorAll('li').forEach(li => {
        const raw = clean(li.textContent, 2500);
        if (!raw || raw.length > 2200) return;
        const m = raw.match(/^\s*([^:]{1,120})\s*:\s*(.{1,2000})$/);
        if (m) addSpec(specs, m[1], m[2]);
      });
    });

    // Explicit "Item specifications" / "Product details" heading fallback.
    document.querySelectorAll('h1,h2,h3,h4,h5,span,div').forEach(heading => {
      const label = clean(heading.textContent, 160);
      if (!label || !/^(item\s+specifications?|product\s+details|technical\s+details)$/i.test(label)) return;
      const section = heading.closest('section') || heading.parentElement?.parentElement || heading.parentElement;
      if (!section) return;
      section.querySelectorAll('tr').forEach(parseRow);
      section.querySelectorAll('dt').forEach(dt => {
        const dd = dt.nextElementSibling;
        if (dd && dd.matches('dd')) addSpec(specs, dt.textContent, dd.textContent);
      });
    });

    // Newer Amazon layouts sometimes render Product Overview as paired spans/divs
    // instead of a table. Only accept a conservative whitelist of real item
    // attribute names so reviews/BSR/ASIN do not leak into specifications.
    document.querySelectorAll('#productOverview_feature_div, #productOverview, #productDetails, #productDetails_feature_div').forEach(root => {
      root.querySelectorAll('*').forEach(el => {
        const raw = clean(el.textContent, 600);
        if (!raw || raw.length > 500) return;
        const m = raw.match(/^\s*([^:]{2,100})\s*:\s*(.{1,350})\s*$/);
        if (m && EBAY_SPEC_HINTS.test(normalizeSpecName(m[1]) || '')) addSpec(specs, m[1], m[2]);
      });
    });

    // Embedded state fallback: only accept clear displayName/displayValue pairs.
    for (const script of document.scripts) {
      const raw = script.textContent || '';
      if (!raw || specs.length >= 200) continue;
      const re = /"(?:displayName|name)"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"(?:displayValue|value)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
      let m;
      while ((m = re.exec(raw)) && specs.length < 200) {
        try {
          const name = JSON.parse('"' + m[1].replace(/"/g, '\\"') + '"');
          const value = JSON.parse('"' + m[2].replace(/"/g, '\\"') + '"');
          addSpec(specs, name, value);
        } catch (_) {}
      }
    }

    // Remove obvious non-item fields even when Amazon labels them differently.
    const bad = /^(asin|manufacturer|department|date first available|best sellers rank|customer reviews?|ratings?|upc|ean|isbn|item weight|country of origin|model number|part number|warranty)$/i;
    return specs.filter(s => !bad.test(s.name)).slice(0, 150);
  }

  function collectProductInformation(specs) {
    const info = {};
    const aliases = {
      manufacturer: ['manufacturer'], modelNumber: ['item model number','model number','model'], partNumber: ['part number'],
      itemWeight: ['item weight','weight'], itemDimensions: ['product dimensions','item dimensions lxwxh','dimensions'],
      countryOfOrigin: ['country of origin'], department: ['department'], dateFirstAvailable: ['date first available'],
      asin: ['asin'], upc: ['upc'], ean: ['ean'], isbn: ['isbn'], warranty: ['warranty'],
      color: ['color','colour'], material: ['material'], size: ['size'],
    };
    for (const [key, names] of Object.entries(aliases)) {
      const hit = specs.find(s => names.includes(s.name.toLowerCase()));
      if (hit) info[key] = hit.value;
    }
    // Product-information fields live in the detail bullets/additional-info area.
    const roots = document.querySelectorAll('#productDetails_detailBullets_sections1, #productDetails_detailBullets_sections2, #detailBullets_feature_div');
    for (const root of roots) {
      root.querySelectorAll('tr').forEach(row => {
        const cells = [...row.querySelectorAll('th,td')].map(c => clean(c.textContent, 2000)).filter(Boolean);
        if (cells.length >= 2) {
          const name = cells[0].toLowerCase();
          const val = cells.slice(1).join(' ');
          const key = Object.entries(aliases).find(([, names]) => names.includes(name))?.[0];
          if (key && !info[key]) info[key] = val;
        }
      });
      root.querySelectorAll('li').forEach(li => {
        const raw = clean(li.textContent, 2500);
        const m = raw?.match(/^\s*([^:]{1,120})\s*:\s*(.{1,2000})$/);
        if (!m) return;
        const name = m[1].toLowerCase();
        const key = Object.entries(aliases).find(([, names]) => names.includes(name))?.[0];
        if (key && !info[key]) info[key] = clean(m[2], 2000);
      });
    }
    return info;
  }

  function collectCategories() {
    const out = [];
    const add = v => { const x = clean(v, 300); if (x && !/^home$/i.test(x) && !out.some(y => y.toLowerCase() === x.toLowerCase())) out.push(x); };
    document.querySelectorAll('#wayfinding-breadcrumbs_feature_div li, #wayfinding-breadcrumbs_feature_div a, .a-breadcrumb li, .a-breadcrumb a, [data-feature-name="wayfinding-breadcrumbs"] li, [data-feature-name="wayfinding-breadcrumbs"] a').forEach(el => add(text(el, 300)));
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || ''); const nodes = Array.isArray(parsed) ? parsed : [parsed];
        nodes.forEach(n => (Array.isArray(n?.itemListElement) ? n.itemListElement : []).forEach(i => add(i?.name || i?.item?.name)));
      } catch (_) {}
    }
    const json = getJsonLd(); if (json.category) add(json.category);
    return out.slice(0, 30);
  }

  function cleanDescription(value) {
    if (!value) return null;
    const box = document.createElement('div'); box.innerHTML = String(value);
    box.querySelectorAll('script,style,noscript,template,svg').forEach(n => n.remove());
    box.querySelectorAll('*').forEach(el => { [...el.attributes].forEach(a => { if (/^on/i.test(a.name) || a.name === 'style') el.removeAttribute(a.name); }); });
    return clean(box.textContent, 30000);
  }

  function extractDescription() {
    const json = getJsonLd();
    const selectors = [
      '#productDescription_feature_div #productDescription',
      '#productDescription',
      '#productDescriptionText',
      '#bookDescription_feature_div .a-expander-content',
      '#bookDescription_feature_div',
      '[data-feature-name="productDescription"] #productDescription',
      '[data-feature-name="productDescription"] .a-expander-content',
      '[data-cy="product-description"]',
      '[data-testid="product-description"]',
      '.product-description'
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const value = cleanDescription(el.innerHTML || el.textContent);
        if (value && value.length > 20 && !/^(description|see more)$/i.test(value) &&
            !/Product\s+summary\s+presents\s+key\s+product\s+information|Keyboard\s+shortcut/i.test(value)) return value;
      }
    }
    const jsonDescription = cleanDescription(json.description);
    if (jsonDescription && jsonDescription.length > 20 && !/Product\s+summary|Keyboard\s+shortcut/i.test(jsonDescription)) return jsonDescription;
    const metaDescription = cleanDescription(document.querySelector('meta[name="description"]')?.content);
    if (metaDescription && metaDescription.length > 30 && !/amazon\.com|Product\s+summary|Keyboard\s+shortcut/i.test(metaDescription)) return metaDescription;
    const bullets = unique([...document.querySelectorAll('#feature-bullets li, #feature-bullets .a-list-item')]
      .map(el => cleanHighlight(el.textContent)).filter(Boolean)).slice(0, 10);
    if (bullets.length) return bullets.join('\n\n');
    return null;
  }

  function extractAplus() {
    const root = document.querySelector('#aplus, #aplus_feature_div, [data-feature-name="aplus"]');
    if (!root) return { text: null, images: [] };
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,template,svg').forEach(n => n.remove());
    const textValue = clean(clone.textContent, 30000);
    const images = [];
    clone.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('data-src') || img.getAttribute('src') || img.getAttribute('data-a-hi-res-src');
      const u = absolute(src); if (u && /^https?:\/\//i.test(u) && !isLikelyVideoThumbnail(img, u)) images.push(normalizeImage(u));
    });
    return { text: textValue, images: unique(images).slice(0, 30) };
  }

  function isLikelyVideoThumbnail(img, rawUrl) {
    if (!img) return false;
    const url = String(rawUrl || '').toLowerCase();

    // Do not reject an entire product gallery just because a parent wrapper
    // happens to contain the word "video". Amazon commonly places the video
    // tile beside normal gallery images inside the same image block.
    if (img.closest('video')) return true;
    if (img.matches?.('[data-video], [data-video-id], [data-video-url]')) return true;

    const explicitVideoAttrs = [
      img.getAttribute('data-video'),
      img.getAttribute('data-video-id'),
      img.getAttribute('data-video-url'),
      img.getAttribute('data-video-thumbnail'),
      img.getAttribute('data-playback-url')
    ].filter(Boolean).join(' ');
    if (explicitVideoAttrs) return true;

    // URL filtering is intentionally narrow. Generic "video" text in a URL
    // is not enough because some Amazon CDN paths/parameters can contain it.
    if (/(?:videothumbnail|video_thumb|video-thumbnail|videoplay|playbutton|play-button|player-poster)/i.test(url)) return true;

    const alt = `${img.getAttribute('alt') || ''} ${img.getAttribute('aria-label') || ''}`;
    if (/^(?:play video|watch video|video)$/i.test(alt.trim())) return true;
    return false;
  }

  function normalizeImage(raw) {
    let url = String(raw || '').trim();
    if (!url) return '';
    // Convert Amazon resized image variants to the original CDN image where
    // possible, while preserving the actual file extension.
    url = url.replace(/\._[^.\/]+_\.(jpe?g|png|webp)(?=($|[?#]))/i, '.$1');
    url = url.replace(/\._(?:SX|SY|UX|UY|CR|AC|US|SL)[^.]*(?=\.(?:jpe?g|png|webp)(?:$|[?#]))/gi, '');
    return url;
  }

  function collectImages() {
    const map = new Map();
    const add = (raw, score = 0, sourceImg = null) => {
      const u = absolute(raw);
      if (!u || !/^https?:\/\//i.test(u)) return;
      if (isLikelyVideoThumbnail(sourceImg, u)) return;
      const url = normalizeImage(u);
      if (!url) return;
      const path = url.split('?')[0];
      // Amazon product CDN images are generally image files. Keep extension
      // checks narrow so UI SVG/GIF icons are never imported as product media.
      if (!/\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(path)) return;
      const key = path.toLowerCase();
      const old = map.get(key);
      if (!old || score > old.score) map.set(key, { url, score });
    };

    const gallerySelectors = [
      '#imgTagWrapperId',
      '#landingImage',
      '#altImages',
      '#imageBlock_feature_div',
      '#imageBlock',
      '#main-image-container',
      '[data-feature-name="imageBlock"]',
      '[data-feature-name="image"]'
    ];

    const roots = [];
    gallerySelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (!roots.includes(el)) roots.push(el);
      });
    });

    // Main product image from Product JSON-LD.
    const json = getJsonLd();
    const jsonImages = Array.isArray(json.image) ? json.image : [json.image];
    jsonImages.filter(Boolean).forEach(u => add(u, 15000));

    const processImage = (img, baseScore = 5000) => {
      if (!img) return;
      const attrs = [
        ['data-old-hires', 12000],
        ['data-a-hi-res-src', 12000],
        ['data-hi-res-src', 11500],
        ['data-src', 9000],
        ['data-lazy-src', 8500],
        ['data-image-src', 8500],
        ['data-original', 8000]
      ];
      attrs.forEach(([name, score]) => add(img.getAttribute(name), score, img));

      const dynamic = img.getAttribute('data-a-dynamic-image');
      if (dynamic) {
        try {
          const data = JSON.parse(dynamic);
          Object.entries(data)
            .sort((a, b) => {
              const aa = Array.isArray(a[1]) ? Number(a[1][0]) * Number(a[1][1]) : 0;
              const bb = Array.isArray(b[1]) ? Number(b[1][0]) * Number(b[1][1]) : 0;
              return bb - aa;
            })
            .forEach(([u, d]) => {
              const area = Array.isArray(d) ? Number(d[0]) * Number(d[1]) : 0;
              add(u, 10000 + Math.min(area / 1000, 4000), img);
            });
        } catch (_) {}
      }

      add(img.currentSrc, baseScore + 500, img);
      add(img.src, baseScore, img);
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        srcset.split(',').forEach(part => {
          const u = part.trim().split(/\s+/)[0];
          if (u) add(u, baseScore - 100, img);
        });
      }
    };

    // Read every image element in the real product gallery, including lazy
    // loaded thumbnail images. This is the key path for modern Amazon pages.
    roots.forEach(root => {
      if (root.matches?.('img')) processImage(root, 13000);
      root.querySelectorAll('img').forEach(img => processImage(img, 7000));
    });

    // Explicit main-image fallbacks.
    document.querySelectorAll('#landingImage, #imgTagWrapperId img, #imgBlkFront').forEach(img => processImage(img, 14000));

    // Amazon sometimes exposes gallery URLs on thumbnail nodes without a
    // usable <img> src. Read common thumbnail metadata attributes too.
    document.querySelectorAll('#altImages li, #altImages [data-csa-c-item-id], #altImages [data-csa-c-type]').forEach(el => {
      [
        'data-old-hires', 'data-a-hi-res-src', 'data-hi-res-src',
        'data-src', 'data-image-src', 'data-a-dynamic-image'
      ].forEach(name => {
        const value = el.getAttribute(name);
        if (!value) return;
        if (name === 'data-a-dynamic-image') {
          try {
            const data = JSON.parse(value);
            Object.keys(data).forEach(u => add(u, 9000, el.querySelector('img')));
          } catch (_) {}
        } else {
          add(value, 8500, el.querySelector('img'));
        }
      });
    });

    return [...map.values()]
      .sort((a, b) => b.score - a.score)
      .map(x => x.url)
      .slice(0, 30);
  }

  function extractRatingAndRank() {
    const rating = clean(getJsonLd().aggregateRating?.ratingValue || document.querySelector('#acrPopover .a-icon-alt')?.textContent, 100);
    const reviewCount = clean(getJsonLd().aggregateRating?.reviewCount || document.querySelector('#acrCustomerReviewText')?.textContent, 100);
    const rank = [];
    const root = document.querySelector('#detailBulletsWrapper_feature_div, #productDetails_detailBullets_sections1, #productDetails');
    if (root) {
      const raw = clean(root.textContent, 10000) || '';
      const m = raw.match(/Best Sellers Rank\s*#?\s*([^\n]+?)(?=\s*(?:Customer Reviews|Date First Available|$))/i);
      if (m) rank.push(clean(m[1], 1000));
    }
    return { rating: rating ? Number.parseFloat(rating) || null : null, ratingsTotal: reviewCount, bestSellersRank: rank[0] || null };
  }

  function cleanProductTitle(value) {
    let t = clean(value, 1000);
    if (!t) return '';
    // Amazon can inject an accessibility/product-summary control into generic title containers.
    t = t
      .replace(/Product\s+summary\s+presents\s+key\s+product\s+information/ig, ' ')
      .replace(/Keyboard\s+shortcut\s+(?:shift\s*\+\s*){1,6}(?:alt\s*\+\s*)?(?:opt\s*\+\s*)?[a-z0-9]+/ig, ' ')
      .replace(/Keyboard\s+shortcut[^.\n]*/ig, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return t;
  }

  function extractProductTitle(json) {
    const candidates = [
      text(document.querySelector('#productTitle')),
      text(document.querySelector('h1#title')),
      text(document.querySelector('[data-feature-name="title"] h1')),
      clean(json?.name, 1000),
    ];
    for (const candidate of candidates) {
      const cleaned = cleanProductTitle(candidate);
      if (cleaned && !/^(?:Product\s+summary\s+presents\s+key\s+product\s+information|Keyboard\s+shortcut.*)$/i.test(cleaned)) return cleaned;
    }
    return '';
  }

  function extract() {
    const json = getJsonLd();
    const asin = getAsin();
    const title = extractProductTitle(json);
    const priceRaw = json.offers?.price ?? text(document.querySelector('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox, .a-price .a-offscreen'), 100);
    const currency = currencyForHost(location.hostname) || clean(json.offers?.priceCurrency, 8) || 'USD';
    const specifications = collectItemSpecifications();
    const info = collectProductInformation(specifications);
    const categories = collectCategories();
    const aplus = extractAplus();
    const reviews = extractRatingAndRank();
    const bullets = unique([...document.querySelectorAll('#feature-bullets li, #feature-bullets .a-list-item')].map(el => cleanHighlight(el.textContent)).filter(Boolean)).slice(0, 20);
    const availability = clean(document.querySelector('#availability span, #outOfStock, #buybox-see-all-buying-choices-announce, #availability')?.textContent, 500);
    const brand = clean(json.brand?.name || text(document.querySelector('#bylineInfo, #brand'), 300), 300);
    const images = collectImages();
    const description = extractDescription();
    const product = {
      asin, title, description, bulletPoints: bullets, images, price: parsePrice(priceRaw), currency,
      availability, rating: reviews.rating, ratingsTotal: reviews.ratingsTotal, bestSellersRank: reviews.bestSellersRank,
      brand: brand || null, manufacturer: info.manufacturer || null, modelNumber: info.modelNumber || null,
      partNumber: info.partNumber || null, itemWeight: info.itemWeight || null, itemDimensions: info.itemDimensions || null,
      countryOfOrigin: info.countryOfOrigin || null, department: info.department || null, dateFirstAvailable: info.dateFirstAvailable || null,
      upc: info.upc || null, ean: info.ean || null, isbn: info.isbn || null, warranty: info.warranty || null,
      color: info.color || null, material: info.material || null, size: info.size || null,
      sourceUrl: location.href, categories, categoryPath: categories.join(' > '), specifications,
      productInformation: info, aplusContent: aplus, variantDimensions: [],
      variants: [], sourceMarketplace: location.hostname
    };
    if (!product.asin) product.asin = info.asin || null;
    return product;
  }


  function installFloatingImporter() {
    if (document.getElementById('__elms-floating-host')) return;
    const host = document.createElement('div');
    host.id = '__elms-floating-host';
    host.style.cssText = 'position:fixed;right:18px;bottom:22px;width:58px;height:58px;z-index:2147483647;';
    const shadow = host.attachShadow({mode:'closed'});
    const style = document.createElement('style');
    style.textContent = `
      .wrap{position:relative;width:58px;height:58px;font-family:Inter,-apple-system,"Segoe UI",Arial,sans-serif}
      button{position:relative;width:58px;height:58px;border:0;border-radius:18px;padding:8px;background:linear-gradient(145deg,#0f172a,#172554);box-shadow:0 8px 26px rgba(15,23,42,.35),0 0 0 3px rgba(255,255,255,.9);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .16s,box-shadow .16s}
      button::after{content:"";position:absolute;left:10px;right:10px;bottom:-3px;height:3px;border-radius:3px;background:linear-gradient(90deg,#e53238 0 25%,#0064d2 25% 50%,#f5af02 50% 75%,#86b817 75%)}
      button:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(15,23,42,.42),0 0 0 3px #fff}
      button:active{transform:scale(.96)}
      button[disabled]{cursor:wait;opacity:.85}
      button[disabled] img{animation:pulse 1s ease-in-out infinite}
      @keyframes pulse{50%{opacity:.45;transform:scale(.92)}}
      img{width:100%;height:100%;object-fit:contain;border-radius:11px;display:block}
      .dot{position:absolute;right:-3px;top:-3px;width:14px;height:14px;border-radius:50%;background:#86b817;border:2px solid #fff;box-sizing:border-box;display:none}
      .toast{position:absolute;right:70px;bottom:0;min-width:220px;max-width:300px;padding:11px 14px;border-radius:12px;background:#0f172a;color:#fff;font-size:12.5px;line-height:1.4;white-space:pre-line;box-shadow:0 12px 30px rgba(15,23,42,.3);border-left:4px solid #0064d2;display:none}
      .toast.show{display:block;animation:in .18s ease-out}
      @keyframes in{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}
      .toast.ok{border-left-color:#86b817}.toast.err{border-left-color:#e53238;background:#2a1216}.toast.busy{border-left-color:#f5af02}
    `;
    const wrap = document.createElement('div'); wrap.className='wrap';
    const button = document.createElement('button'); button.type='button'; button.title='Import this Amazon product to ELMS';
    const img = document.createElement('img'); img.alt='ELMS'; img.src=chrome.runtime.getURL('logo.png');
    const dot = document.createElement('span'); dot.className='dot';
    const toast = document.createElement('div'); toast.className='toast';
    button.append(img); wrap.append(button,dot,toast); shadow.append(style,wrap); document.documentElement.appendChild(host);

    const show = (message, kind='busy') => {
      toast.textContent=message; toast.className=`toast show ${kind}`;
      if (kind !== 'busy') setTimeout(()=>toast.className='toast', 3200);
    };
    const setConnectedDot = async () => {
      try {
        const d=await chrome.storage.local.get(['extensionKey','sessionToken']);
        dot.style.display = d.extensionKey && d.sessionToken ? 'block' : 'none';
      } catch (_) {}
    };
    setConnectedDot();

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled=true;
      show('Reading this Amazon page…','busy');
      try {
        const product=extract();
        const isAmazonProduct=/^https:\/\/(?:www\.)?amazon\.[a-z.]+\/(?:[^?#]*\/)?(?:dp|gp\/product|product)\//i.test(location.href) || !!product.asin;
        if (!isAmazonProduct || !product.asin || !product.title) {
          throw new Error('Amazon product page not detected. Open a product page and try again.');
        }
        show('Sending product to ELMS…','busy');
        const response=await new Promise(resolve=>chrome.runtime.sendMessage({type:'ELMS_IMPORT_PRODUCT',product,amazonUrl:location.href},resolve));
        if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
        if (!response?.success) throw new Error(response?.error || 'Could not import this product.');
        dot.style.display='block';
        const saved=response.result?.product || product;
        show(`✓ Saved to ELMS Drafts\n${saved.asin || product.asin} · ${saved.images?.length || product.images?.length || 0} images`,'ok');
      } catch (e) {
        show(e?.message || 'Import failed.','err');
      } finally {
        setTimeout(()=>{button.disabled=false;},700);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installFloatingImporter, {once:true});
  else installFloatingImporter();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ELMS_GET_PRODUCT') return false;
    try { sendResponse({ success: true, product: extract() }); } catch (e) { sendResponse({ success: false, error: e?.message || 'Could not extract Amazon product.' }); }
    return true;
  });
})();
