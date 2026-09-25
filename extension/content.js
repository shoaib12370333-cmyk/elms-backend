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

  // Where the price of the product shown is on the page (the import and the panel read the same place).
  const PRICE_SELECTOR = '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox, .a-price .a-offscreen';

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

  // ---------- variants: colour / size / ... each with its own pictures, title and price ----------
  const MAX_VARIANTS = 30;
  const MAX_VARIANT_IMAGES = 12;
  const ASIN_RE = /^[A-Z0-9]{10}$/;

  // The {...} or [...] that starts at text[start], read with string quoting in mind (null when it never closes).
  function sliceJson(text, start) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  // The parsed value of  "key": {...}  or  "key": [...]  inside a page script (Amazon writes some keys with single quotes).
  function jsonAfterKey(text, key, afterIndex = 0) {
    const re = new RegExp('["\']' + key + '["\']\\s*:\\s*([\\[{])', 'g');
    re.lastIndex = afterIndex;
    const m = re.exec(text);
    if (!m) return null;
    const raw = sliceJson(text, m.index + m[0].length - 1);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  const scriptTexts = (root) => [...root.querySelectorAll('script')].map((s) => s.textContent || '').filter(Boolean);
  const prettyDimension = (key) => String(key || '').replace(/_name$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const asinFromUrl = (url) => (String(url || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i) || [])[1]?.toUpperCase() || null;

  // What Amazon puts in the page for the colour / size picker: which ASIN is which combination.
  function readTwister(root) {
    for (const t of scriptTexts(root)) {
      if (!/dimensionValuesDisplayData|asinVariationValues/.test(t)) continue;
      const display = jsonAfterKey(t, 'dimensionValuesDisplayData');
      const asinValues = jsonAfterKey(t, 'asinVariationValues');
      const variationValues = jsonAfterKey(t, 'variationValues');
      const labels = jsonAfterKey(t, 'variationDisplayLabels');
      const dimsDisplay = jsonAfterKey(t, 'dimensionsDisplay');
      const dims = jsonAfterKey(t, 'dimensions');
      const strings = (a) => Array.isArray(a) && a.length && a.every((x) => typeof x === 'string');
      const keys = strings(dims) ? dims : null;
      let names = strings(dimsDisplay) ? dimsDisplay.slice() : keys ? keys.map((k) => (labels && labels[k]) || prettyDimension(k)) : [];
      const values = {};
      if (display && typeof display === 'object') {
        for (const [asin, vals] of Object.entries(display)) {
          if (ASIN_RE.test(asin) && Array.isArray(vals)) values[asin] = vals.map((v) => clean(v, 200) || '');
        }
      }
      if (!Object.keys(values).length && asinValues && variationValues && keys) {
        for (const [asin, o] of Object.entries(asinValues)) {
          if (!ASIN_RE.test(asin) || !o) continue;
          values[asin] = keys.map((k) => { const list = variationValues[k]; return Array.isArray(list) ? clean(list[Number(o[k])], 200) || '' : ''; });
        }
      }
      if (Object.keys(values).length) return { names, values };
    }
    return null;
  }

  // The picker's own pictures: one small swatch per colour, made full size.
  function readSwatches(root) {
    const map = new Map();
    root.querySelectorAll('#twisterContainer li, [id^="variation_"] li, #twister li, [id^="inline-twister"] li').forEach((li) => {
      const asin = (li.getAttribute('data-asin') || li.getAttribute('data-defaultasin') || asinFromUrl(li.getAttribute('data-dp-url')) || '').toUpperCase();
      if (!ASIN_RE.test(asin)) return;
      const img = li.querySelector('img');
      const src = img && (img.getAttribute('src') || img.getAttribute('data-src'));
      const url = src ? normalizeImage(absolute(src) || '') : '';
      if (url && /^https?:\/\//i.test(url) && !map.has(asin)) map.set(asin, url);
    });
    return map;
  }

  // When the page has no data block for the picker: the picker itself (each colour / size button and its ASIN).
  function readPickerButtons(root) {
    const variants = [];
    root.querySelectorAll('[id^="variation_"]').forEach((box) => {
      const dimName = clean(text(box.querySelector('label, .a-form-label')), 80)?.replace(/:\s*$/, '') || prettyDimension(box.id.replace(/^variation_/, ''));
      box.querySelectorAll('li').forEach((li) => {
        const asin = (li.getAttribute('data-asin') || li.getAttribute('data-defaultasin') || asinFromUrl(li.getAttribute('data-dp-url')) || '').toUpperCase();
        if (!ASIN_RE.test(asin)) return;
        const label = clean((li.getAttribute('title') || '').replace(/^click to select\s*/i, ''), 200) || clean(li.querySelector('img')?.getAttribute('alt'), 200) || text(li, 200);
        if (label) variants.push({ asin, dim: dimName, value: label });
      });
      box.querySelectorAll('select option, [id^="native_dropdown_selected_"] option').forEach((opt) => {
        const asin = (String(opt.value || '').split(',').pop() || '').toUpperCase();
        const label = clean(opt.textContent, 200);
        if (ASIN_RE.test(asin) && label && !/^select/i.test(label)) variants.push({ asin, dim: dimName, value: label });
      });
    });
    return variants;
  }

  // Every variant that can be told from the page itself (no extra requests): ASIN, what makes it different, its swatch picture.
  function collectVariantsQuick() {
    const current = getAsin();
    const swatches = readSwatches(document);
    const twister = readTwister(document);
    let variants = [];
    if (twister) {
      variants = Object.entries(twister.values).map(([asin, vals]) => ({
        asin,
        dimensions: vals.map((value, i) => ({ name: twister.names[i] || `Option ${i + 1}`, value })).filter((d) => d.value),
      }));
    } else {
      const seen = new Map();
      readPickerButtons(document).forEach((b) => { if (!seen.has(b.asin)) seen.set(b.asin, { asin: b.asin, dimensions: [{ name: b.dim, value: b.value }] }); });
      variants = [...seen.values()];
    }
    return variants.slice(0, MAX_VARIANTS).map((v) => ({
      asin: v.asin,
      label: v.dimensions.map((d) => d.value).join(' / '),
      dimensions: v.dimensions,
      image: swatches.get(v.asin) || null,
      images: [],
      title: null,
      price: null,
      availability: null,
      isCurrentProduct: v.asin === current,
    }));
  }

  // The gallery pictures Amazon lists for the product shown (colorImages.initial), full size, videos left out.
  function galleryFromScripts(texts) {
    for (const t of texts) {
      const at = t.search(/["']colorImages["']\s*:\s*\{\s*["']initial["']\s*:\s*\[/);
      if (at < 0) continue;
      const list = jsonAfterKey(t, 'initial', at);
      if (!Array.isArray(list)) continue;
      const urls = [];
      for (const item of list) {
        if (!item || item.videoUrl || /video/i.test(String(item.variant || ''))) continue;
        let u = item.hiRes || item.large;
        if (!u && item.main && typeof item.main === 'object') {
          u = Object.entries(item.main).sort((a, b) => (Number(b[1]?.[0]) || 0) - (Number(a[1]?.[0]) || 0))[0]?.[0];
        }
        u = u ? normalizeImage(u) : '';
        if (u && /^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
      }
      if (urls.length) return urls;
    }
    return [];
  }

  // A variant's own product page (same site, so the browser's own session is used): pictures, title, price, stock.
  async function fetchVariantPage(asin) {
    const res = await fetch(`${location.origin}/dp/${asin}?th=1&psc=1`, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    if (/validateCaptcha|Enter the characters you see below|Robot Check/i.test(html)) return 'blocked';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const images = galleryFromScripts(scriptTexts(doc));
    if (!images.length) {
      const og = doc.querySelector('meta[property="og:image"]')?.content;
      if (og) images.push(normalizeImage(og));
    }
    return {
      images,
      title: cleanProductTitle(text(doc.querySelector('#productTitle'))) || null,
      price: parsePrice(text(doc.querySelector('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox, .a-price .a-offscreen'), 100)),
      availability: clean(doc.querySelector('#availability span, #availability')?.textContent, 200),
    };
  }

  // Fills in each variant's pictures, title, price and stock. Never throws and never takes more than ~25 seconds:
  // a variant that could not be read keeps what the page already told us (its swatch picture and what makes it different).
  async function enrichVariants(product, onProgress) {
    const list = product.variants;
    if (!list.length) return;
    const base = product.title || '';
    const current = list.find((v) => v.isCurrentProduct);
    if (current) {
      current.images = product.images.slice(0, MAX_VARIANT_IMAGES);
      current.image = product.images[0] || current.image;
      current.price = product.price;
      current.availability = product.availability;
      current.pageTitle = base;
    }
    const queue = list.filter((v) => !v.isCurrentProduct);
    const total = queue.length;
    let done = 0;
    let blocked = false;
    const started = Date.now();
    const worker = async () => {
      while (queue.length && !blocked && Date.now() - started < 25000) {
        const v = queue.shift();
        try {
          const data = await fetchVariantPage(v.asin);
          if (data === 'blocked') blocked = true;
          else if (data) {
            v.images = data.images.slice(0, MAX_VARIANT_IMAGES);
            v.image = v.images[0] || v.image;
            v.price = data.price ?? v.price;
            v.availability = data.availability || v.availability;
            v.pageTitle = data.title || null;
          }
        } catch (_) { /* this variant keeps what the page told us */ }
        done += 1;
        if (onProgress) onProgress(`Reading variants ${done}/${total}…`);
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // A title of its own: the variant page's title when it differs from the product's, else the product title + what makes it different.
    list.forEach((v) => {
      v.title = v.pageTitle && v.pageTitle !== base ? v.pageTitle : (v.label ? `${base} - ${v.label}`.slice(0, 200) : base);
      delete v.pageTitle;
    });
  }

  async function extractWithVariants(onProgress) {
    const product = extract();
    let skip = false;
    try { skip = !!(await chrome.storage.local.get(['skipVariants'])).skipVariants; } catch (_) { /* variants are read */ }
    if (!skip && product.variants.length > 1) await enrichVariants(product, onProgress);
    else product.variants = []; // a product with one option has no variants to speak of - or the person chose to import this option only
    return product;
  }

  function extract() {
    const json = getJsonLd();
    const asin = getAsin();
    const title = extractProductTitle(json);
    const priceRaw = json.offers?.price ?? text(document.querySelector(PRICE_SELECTOR), 100);
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
    product.variants = collectVariantsQuick();
    product.variantDimensions = [...new Set(product.variants.flatMap((v) => v.dimensions.map((d) => d.name)))];
    return product;
  }


  // ---------- the light read of the page the panel works from: it runs often, so it never fetches anything ----------
  const UNAVAILABLE_RE = /currently unavailable|out of stock|no featured offers|not available|derzeit nicht|nicht verf[uü]gbar|actuellement indisponible|non disponibile|no disponible|niet beschikbaar/i;
  const LIST_PRICE_SELECTOR = '.basisPrice .a-offscreen, #listPrice, #priceblock_listprice, .a-price[data-a-strike="true"] .a-offscreen';
  const DELIVERY_SELECTOR = '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE, #mir-layout-DELIVERY_BLOCK-slot-DELIVERY_MESSAGE, #deliveryBlockMessage, #delivery-message, #ddmDeliveryMessage, [data-csa-c-content-id="DEXUnifiedCXPDM"]';
  const asCount = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
  const variantCounts = new Map();
  const gtinCache = new Map();

  // The product's barcode (EAN / UPC / ISBN) when the page shows one: it finds the very same product on eBay.
  function readGtin(json) {
    let value = json.gtin13 || json.gtin12 || json.gtin14 || json.gtin8 || json.gtin || null;
    if (!value) {
      try { const info = collectProductInformation([]); value = info.ean || info.upc || info.isbn || null; } catch (_) { value = null; }
    }
    const m = String(value == null ? '' : value).match(/[0-9]{8,14}/);
    return m ? m[0] : null;
  }

  // A product page (not a search or list page, where [data-asin] belongs to the first result).
  const isProductPage = () => /\/(?:dp|gp\/product|product)\/[A-Z0-9]{10}/i.test(location.pathname) || !!document.querySelector('#productTitle');

  // Who sells it and who ships it (the seller link and the buy box wording differ between Amazon layouts).
  function readSeller() {
    const tabular = (name) => text(document.querySelector(`#tabular-buybox [tabular-attribute-name="${name}"] .tabular-buybox-text`), 200);
    const merchant = text(document.querySelector('#merchant-info'), 400) || '';
    let soldBy = text(document.querySelector('#sellerProfileTriggerId'), 200) || tabular('Sold by') || tabular('Sold By') || null;
    if (!soldBy && merchant) {
      const m = merchant.match(/sold by\s+(.+?)(?:\s+and\s+|\.|$)/i);
      soldBy = m ? clean(m[1], 120) : (/amazon/i.test(merchant) ? 'Amazon' : null);
    }
    const shipsFrom = tabular('Ships from') || tabular('Dispatches from') || clean((merchant.match(/(?:ships|dispatched) from\s+(.+?)(?:\s+and\s+|\.|$)/i) || [])[1], 120) || null;
    return {
      soldBy,
      shipsFrom,
      amazonSold: !!soldBy && /^amazon(\.|\s|$)/i.test(soldBy),
      fulfilledByAmazon: /^amazon/i.test(shipsFrom || '') || /fulfilled by amazon|(?:ships|dispatched) from and sold by amazon/i.test(merchant),
    };
  }

  // What the panel needs from the page right now.
  function snapshot() {
    const json = getJsonLd();
    const asin = getAsin();
    const availability = clean(document.querySelector('#availability span, #outOfStock, #buybox-see-all-buying-choices-announce, #availability')?.textContent, 500);
    const reviews = extractRatingAndRank();
    const seller = readSeller();
    let variantCount = variantCounts.get(asin);
    if (variantCount === undefined) {
      try { variantCount = collectVariantsQuick().length; } catch (_) { variantCount = 0; }
      variantCounts.set(asin, variantCount);
    }
    let gtin = gtinCache.get(asin);
    if (gtin === undefined) { gtin = readGtin(json); gtinCache.set(asin, gtin); }
    return {
      asin,
      gtin,
      title: extractProductTitle(json),
      brand: clean(json.brand?.name || text(document.querySelector('#bylineInfo, #brand'), 300), 300),
      bullets: unique([...document.querySelectorAll('#feature-bullets li, #feature-bullets .a-list-item')].map((el) => cleanHighlight(el.textContent)).filter(Boolean)).slice(0, 20),
      price: parsePrice(json.offers?.price ?? text(document.querySelector(PRICE_SELECTOR), 100)),
      listPrice: parsePrice(text(document.querySelector(LIST_PRICE_SELECTOR), 100)),
      currency: currencyForHost(location.hostname) || clean(json.offers?.priceCurrency, 8) || 'USD',
      unavailable: UNAVAILABLE_RE.test(availability || ''),
      hasCart: !!document.querySelector('#add-to-cart-button, #buy-now-button, input[name="submit.add-to-cart"], #add-to-cart-button-ubb'),
      deliveryText: clean(document.querySelector(DELIVERY_SELECTOR)?.textContent, 300),
      rating: reviews.rating,
      ratingCount: asCount(reviews.ratingsTotal),
      imageCount: new Set([...document.querySelectorAll('#altImages li.imageThumbnail, #altImages li.item')]).size,
      dealBadge: !!text(document.querySelector('#dealBadge_feature_div, #dealBadgeSupportingText, .dealBadge'), 100),
      variantCount,
      ...seller,
    };
  }

  // Settings the popup keeps (chrome.storage.local); read again whenever they change.
  async function readSettings() {
    try {
      const d = await chrome.storage.local.get(['extensionKey', 'sessionToken', 'markup', 'storeId', 'fees', 'autoOpen', 'skipVariants']);
      return { connected: !!d.extensionKey, hasSession: !!d.sessionToken, markup: d.markup == null ? '' : String(d.markup), storeId: d.storeId || null, fees: ELMS_LOGIC.normalizeSettings(d.fees), autoOpen: !!d.autoOpen, skipVariants: !!d.skipVariants };
    } catch (_) {
      return { connected: false, hasSession: false, markup: '', storeId: null, fees: ELMS_LOGIC.normalizeSettings({}), autoOpen: false, skipVariants: false };
    }
  }

  // Asks the background script; never throws (an extension that was updated while the page was open answers with an error).
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve({ success: false, error: 'The ELMS extension was updated: reload this page.' });
          else resolve(response || { success: false, error: 'ELMS did not answer.' });
        });
      } catch (_) {
        resolve({ success: false, error: 'The ELMS extension was updated: reload this page.' });
      }
    });
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    kids.forEach((kid) => { if (kid != null) el.append(kid); });
    return el;
  }

  // ---------- bulk import: product lists (search results, bestsellers ...) ----------
  const CARD_SELECTOR = '[data-component-type="s-search-result"][data-asin], #gridItemRoot, .zg-grid-general-faceout, li.zg-item-immersion, [data-asin]:not([data-asin=""])';
  const PRODUCT_LINK = 'a[href*="/dp/"], a[href*="/gp/product/"]';
  const MAX_PICK = 100;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function cardAsin(el) {
    const direct = String(el.getAttribute('data-asin') || '').toUpperCase();
    if (ASIN_RE.test(direct)) return direct;
    try {
      const holder = el.getAttribute('data-p13n-asin-metadata') ? el : el.querySelector('[data-p13n-asin-metadata]');
      const meta = holder ? JSON.parse(holder.getAttribute('data-p13n-asin-metadata')) : null;
      const asin = meta ? String(meta.asin || '').toUpperCase() : '';
      if (ASIN_RE.test(asin)) return asin;
    } catch (_) { /* the link tells */ }
    const link = el.querySelector(PRODUCT_LINK);
    return link ? asinFromUrl(link.getAttribute('href')) : null;
  }

  // The product cards of a list page: the outermost element of each product that shows a picture and links to it.
  function findCards() {
    const candidates = [...document.querySelectorAll(CARD_SELECTOR)].filter((el) => el.offsetParent !== null && el.querySelector('img') && el.querySelector(PRODUCT_LINK));
    const set = new Set(candidates);
    const seen = new Set();
    const cards = [];
    for (const el of candidates) {
      let nested = false;
      for (let p = el.parentElement; p; p = p.parentElement) { if (set.has(p)) { nested = true; break; } }
      if (nested) continue;
      const asin = cardAsin(el);
      if (asin && !seen.has(asin)) { seen.add(asin); cards.push({ el, asin }); }
    }
    return cards;
  }

  // The little "+ ELMS" badge on a product card lives in the page itself, so its style does too.
  function ensurePickStyle() {
    if (document.getElementById('__elms-pick-style')) return;
    const st = document.createElement('style');
    st.id = '__elms-pick-style';
    st.textContent = '.elms-pick{position:absolute;top:6px;left:6px;z-index:40;background:#0f172a;color:#fff;border-radius:8px;padding:5px 9px;font:700 11px/1 Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none;letter-spacing:.02em}.elms-pick:hover{background:#172554}.elms-pick.on{background:#0064d2}.elms-pick.draft{background:#3f7d0b;cursor:default}.elms-pick.live{background:#64748b;cursor:default}';
    document.head.appendChild(st);
  }

  const removePicks = () => document.querySelectorAll('.elms-pick').forEach((el) => el.remove());

  const PANEL_CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .wrap{position:relative;width:58px;height:58px;font-family:Inter,-apple-system,"Segoe UI",Arial,sans-serif;color:#0f172a}
    .logo{position:relative;width:58px;height:58px;border:0;border-radius:18px;padding:8px;background:linear-gradient(145deg,#0f172a,#172554);box-shadow:0 8px 26px rgba(15,23,42,.35),0 0 0 3px rgba(255,255,255,.9);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .16s,box-shadow .16s}
    .logo::after{content:"";position:absolute;left:10px;right:10px;bottom:-3px;height:3px;border-radius:3px;background:linear-gradient(90deg,#e53238 0 25%,#0064d2 25% 50%,#f5af02 50% 75%,#86b817 75%)}
    .logo:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(15,23,42,.42),0 0 0 3px #fff}
    .logo:active{transform:scale(.96)}
    .logo[disabled]{cursor:wait;opacity:.85}
    .logo[disabled] img{animation:pulse 1s ease-in-out infinite}
    @keyframes pulse{50%{opacity:.45;transform:scale(.92)}}
    .logo img{width:100%;height:100%;object-fit:contain;border-radius:11px;display:block}
    .dot{position:absolute;right:-3px;top:-3px;width:14px;height:14px;border-radius:50%;background:#86b817;border:2px solid #fff;display:none}
    .toast{position:absolute;right:70px;bottom:0;min-width:220px;max-width:300px;padding:11px 14px;border-radius:12px;background:#0f172a;color:#fff;font-size:12.5px;line-height:1.4;white-space:pre-line;box-shadow:0 12px 30px rgba(15,23,42,.3);border-left:4px solid #0064d2;display:none}
    .toast.show{display:block;animation:in .18s ease-out}
    @keyframes in{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}
    .toast.ok{border-left-color:#86b817}.toast.err{border-left-color:#e53238;background:#2a1216}.toast.busy{border-left-color:#f5af02}
    .stack{position:absolute;right:0;bottom:70px;display:none;flex-direction:column;align-items:flex-end;gap:8px}
    .chip{border:0;border-radius:999px;padding:7px 13px 7px 11px;font:700 12.5px/1 Inter,-apple-system,"Segoe UI",Arial,sans-serif;color:#fff;background:#475569;cursor:pointer;box-shadow:0 6px 18px rgba(15,23,42,.28);display:flex;align-items:center;gap:7px;white-space:nowrap}
    .chip::before{content:"";width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.9)}
    .chip.ok{background:#3f7d0b}.chip.warn{background:#b45309}.chip.bad{background:#b91c1c}
    .panel{display:none;width:336px;max-width:calc(100vw - 40px);max-height:calc(100vh - 170px);overflow:auto;background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(15,23,42,.35),0 0 0 1px rgba(15,23,42,.08);font-size:13px;line-height:1.45}
    .panel.open{display:block}
    .ph{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:linear-gradient(135deg,#0f172a,#172554);color:#fff;border-radius:16px 16px 0 0;font-weight:800;font-size:13.5px;position:sticky;top:0}
    .ph button{border:0;background:transparent;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 2px;opacity:.8}
    .pb{padding:12px 14px 14px}
    .sec{margin:0 0 12px}.sec:last-child{margin-bottom:0}
    .lab{display:block;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin:0 0 5px}
    select,input{width:100%;height:36px;border:1.5px solid #e2e8f0;border-radius:9px;padding:0 10px;font:inherit;background:#fff;color:#0f172a}
    select:focus,input:focus{outline:none;border-color:#0064d2;box-shadow:0 0 0 3px rgba(0,100,210,.14)}
    .row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:3px 0}
    .row span:first-child{color:#475569}
    .row.keep{border-top:1px solid #e2e8f0;margin-top:4px;padding-top:7px;font-weight:800;font-size:14px}
    .good{color:#3f7d0b}.loss{color:#b45309}
    .mk{display:flex;gap:8px;align-items:center}
    .mk input{width:78px;flex:none}
    .mk .use{flex:1}
    .use{border:1.5px solid #0064d2;background:#eff6ff;color:#0064d2;border-radius:9px;height:36px;font:700 12px/1.2 Inter,-apple-system,"Segoe UI",Arial,sans-serif;cursor:pointer;padding:0 8px}
    .hint{font-size:11.5px;color:#64748b;margin-top:5px}
    ul.checks{list-style:none;margin:0;padding:0;display:grid;gap:6px}
    ul.checks li{display:flex;gap:8px;font-size:12.5px;align-items:flex-start}
    ul.checks li i{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font:800 11px/1 Inter,Arial,sans-serif;color:#fff;font-style:normal;margin-top:1px}
    li.bad i{background:#dc2626}li.warn i{background:#d97706}li.info i{background:#0064d2}li.ok i{background:#65a30d}
    .go{width:100%;height:42px;border:0;border-radius:11px;background:linear-gradient(135deg,#0064d2,#4f46e5);color:#fff;font:800 13.5px/1 Inter,-apple-system,"Segoe UI",Arial,sans-serif;cursor:pointer;box-shadow:0 8px 18px rgba(0,100,210,.25)}
    .go:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
    .go2{width:100%;height:36px;margin-top:8px;border:1.5px solid #cbd5e1;border-radius:10px;background:#fff;color:#0f172a;font:700 12.5px/1 Inter,-apple-system,"Segoe UI",Arial,sans-serif;cursor:pointer}
    .foot{font-size:11px;color:#94a3b8;margin-top:9px;text-align:center}
    .note{background:#f1f5f9;border-radius:9px;padding:8px 10px;font-size:12px;color:#334155}
    .mk-link{display:block;font-size:12px;color:#0064d2;text-decoration:none;padding:3px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    a.mk-link:hover{text-decoration:underline}
    div.mk-link{color:#475569}
    .bulk-stats{font-size:13px;color:#334155;margin:0 0 8px}
    .bulk-row{display:flex;gap:8px}
    .bulk-row .use{flex:1}
    .use:disabled{opacity:.5;cursor:not-allowed}
    .prog{background:#f1f5f9;border-radius:9px;padding:9px 10px;font-size:12px;color:#334155;white-space:pre-line}
    .prog:empty{display:none}
    .bar{height:6px;border-radius:4px;background:#e2e8f0;margin-top:7px;overflow:hidden}
    .bar i{display:block;height:100%;background:linear-gradient(90deg,#0064d2,#4f46e5);width:0;transition:width .3s}
  `;

  function installFloatingImporter() {
    if (document.getElementById('__elms-floating-host')) return;
    const LOGIC = globalThis.ELMS_LOGIC;
    const host = document.createElement('div');
    host.id = '__elms-floating-host';
    host.style.cssText = 'position:fixed;right:18px;bottom:22px;width:58px;height:58px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;

    // ----- the parts -----
    const logo = h('button', { class: 'logo', type: 'button', title: 'Import this Amazon product to ELMS' }, h('img', { alt: 'ELMS', src: chrome.runtime.getURL('logo.png') }));
    const dot = h('span', { class: 'dot' });
    const toast = h('div', { class: 'toast' });
    const chip = h('button', { class: 'chip', type: 'button', title: 'Profit and checks for this product' });
    const closeBtn = h('button', { type: 'button', 'aria-label': 'Close', text: '×' });
    const storeSelect = h('select');
    const storeSec = h('div', { class: 'sec' }, h('label', { class: 'lab', text: 'eBay store' }), storeSelect);
    const moneyBox = h('div', { class: 'sec' });
    const markupInput = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', 'aria-label': 'Markup percent' });
    const useBtn = h('button', { class: 'use', type: 'button' });
    const markupHint = h('div', { class: 'hint' });
    const markupSec = h('div', { class: 'sec' }, h('label', { class: 'lab', text: 'Your markup %' }), h('div', { class: 'mk' }, markupInput, useBtn), markupHint);
    const marketBody = h('div');
    const marketSec = h('div', { class: 'sec' }, h('label', { class: 'lab', text: 'Market on eBay' }), marketBody);
    const checksList = h('ul', { class: 'checks' });
    const checksSec = h('div', { class: 'sec' }, h('label', { class: 'lab', text: 'Checks' }), checksList);
    const goBtn = h('button', { class: 'go', type: 'button' });
    const openBtn = h('button', { class: 'go2', type: 'button', text: 'Open in ELMS' });
    const foot = h('div', { class: 'foot' });
    const panel = h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { text: 'ELMS · Profit check' }), closeBtn), h('div', { class: 'pb' }, storeSec, moneyBox, markupSec, marketSec, checksSec, h('div', { class: 'sec' }, goBtn, openBtn, foot)));
    // ----- bulk mode parts (search / bestseller pages) -----
    const bulkClose = h('button', { type: 'button', 'aria-label': 'Close', text: '×' });
    const bulkStoreSelect = h('select');
    const bulkStoreSec = h('div', { class: 'sec' }, h('label', { class: 'lab', text: 'eBay store' }), bulkStoreSelect);
    const bulkMarkup = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', 'aria-label': 'Markup percent' });
    const bulkMarkupSec = h('div', { class: 'sec' }, h('label', { class: 'lab', text: 'Your markup %' }), bulkMarkup, h('div', { class: 'hint', text: 'Each product is priced at its Amazon price plus this markup. A small markup loses money after eBay fees: open one product to see what you keep.' }));
    const bulkStats = h('div', { class: 'bulk-stats' });
    const bulkAll = h('button', { class: 'use', type: 'button', text: 'Select all here' });
    const bulkClear = h('button', { class: 'use', type: 'button', text: 'Clear' });
    const bulkProgress = h('div', { class: 'prog' });
    const bulkBarFill = h('i');
    const bulkBar = h('div', { class: 'bar' }, bulkBarFill);
    const bulkGo = h('button', { class: 'go', type: 'button' });
    const bulkFoot = h('div', { class: 'foot' });
    const bulkPanel = h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { text: 'ELMS · Bulk import' }), bulkClose), h('div', { class: 'pb' },
      bulkStoreSec, bulkMarkupSec,
      h('div', { class: 'sec' }, bulkStats, h('div', { class: 'bulk-row' }, bulkAll, bulkClear)),
      h('div', { class: 'sec' }, bulkProgress, bulkBar),
      h('div', { class: 'sec' }, bulkGo, bulkFoot)));
    const stack = h('div', { class: 'stack' }, panel, bulkPanel, chip);
    const wrap = h('div', { class: 'wrap' }, logo, dot, toast, stack);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);

    // ----- state -----
    const S = { ...{ connected: false, hasSession: false, markup: '', storeId: null, fees: LOGIC.normalizeSettings({}), autoOpen: false, skipVariants: false }, page: null, server: null, serverState: 'idle', serverError: '', busy: false, open: false, confirmUntil: 0, mode: null, bulk: { running: false, total: 0, done: 0, failed: 0, lines: [], note: '' } };
    const cache = new Map(); // asin -> { at, data }: ELMS's answer for a product, kept for a minute and a half
    let toastTimer = null;
    let checkSeq = 0;
    let lastSig = '';

    const show = (message, kind = 'busy') => {
      toast.textContent = message;
      toast.className = `toast show ${kind}`;
      clearTimeout(toastTimer);
      if (kind !== 'busy') toastTimer = setTimeout(() => { toast.className = 'toast'; }, kind === 'err' ? 6500 : 4200);
    };

    const money = (n) => LOGIC.formatMoney(n, S.page && S.page.currency);

    // ----- talking to ELMS -----
    async function loadServer(force) {
      const asin = S.page && S.page.asin;
      if (!S.connected || !asin) return;
      const hit = cache.get(asin);
      if (!force && hit && Date.now() - hit.at < 90000) { S.server = hit.data; S.serverState = 'ok'; return; }
      const seq = ++checkSeq;
      S.serverState = 'loading';
      render();
      const r = await send({ type: 'ELMS_CHECK', payload: { asin, amazonUrl: location.href, title: S.page.title, brand: S.page.brand, bulletPoints: S.page.bullets } });
      if (seq !== checkSeq) return; // the person moved on to another product meanwhile
      if (r.success) {
        S.server = r.result;
        S.serverState = 'ok';
        cache.set(asin, { at: Date.now(), data: r.result });
        try { chrome.storage.local.set({ appUrl: r.result.appUrl }); } catch (_) { /* only remembered for opening ELMS pages */ }
      } else {
        S.server = null;
        S.serverState = 'error';
        S.serverError = r.error || 'ELMS could not be reached.';
      }
      render();
    }

    async function refresh(force) {
      if (!isProductPage()) {
        if (S.page) { S.page = null; lastSig = ''; S.server = null; S.serverState = 'idle'; }
        S.mode = findCards().length >= 2 ? 'list' : null; // a page with a list of products (search results, bestsellers ...)
        if (S.mode === 'list') { scanCards(); loadListInfo(); } else removePicks();
        render();
        return;
      }
      if (S.mode !== 'product') { S.mode = 'product'; removePicks(); }
      let page;
      try { page = snapshot(); } catch (_) { return; }
      if (!page.asin) return;
      const sig = JSON.stringify([page.asin, page.price, page.unavailable, page.hasCart, page.soldBy, page.deliveryText, page.title, page.imageCount]);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      const changed = !S.page || S.page.asin !== page.asin;
      S.page = page;
      if (changed) { S.server = null; S.serverState = 'idle'; S.confirmUntil = 0; }
      render();
      if (changed || force) await loadServer(!!force && !changed);
    }


    // ----- what to show -----
    function locate() { return LOGIC.locate(S.server, S.storeId); }

    // May an import go ahead with no eBay store connected? ELMS says so (an admin setting); an older ELMS says nothing, which means no.
    const storeless = () => !!(S.server && S.server.policy && S.server.policy.importWithoutStore);
    // What one product of a bulk import costs, exactly as ELMS says (0 is free, not 1).
    const bulkPer = (c) => (c && c.bulkImportCost != null && Number.isFinite(Number(c.bulkImportCost)) ? Number(c.bulkImportCost) : 1);
    // A loss at the markup in use is a warning, never a reason to stop: the product is saved and the person is told once more.
    function importLossNote() {
      const p = S.page;
      if (!p || p.price == null) return '';
      const r = LOGIC.evaluate(p.price, LOGIC.priceAtMarkup(p.price, S.markup), S.fees);
      return r && r.profit < 0 ? '\n⚠ At this markup you lose ' + money(-r.profit) + ' on every sale after eBay fees.' : '';
    }

    // Why an import cannot go ahead (or null).
    function importBlock() {
      if (!S.connected) return 'Connect your ELMS account first: click the ELMS icon in the Chrome toolbar and paste your Extension Key.';
      if (!S.page) return 'Open an Amazon product page first.';
      if (!S.server) return null;
      const { store, here } = locate();
      if (!S.server.stores.length && !storeless()) return 'Connect an eBay store in ELMS first.';
      if (store && store.amazonOk === false) return store.amazonMessage || 'This Amazon site does not match your store.';
      if (here && here.status !== 'draft') return 'Already ' + (LOGIC.WHERE[here.status] || here.status) + (store ? ' (' + store.label + ')' : '') + '. It cannot be imported again.';
      const c = S.server.credits;
      if (c && !c.unlimited && c.balance < c.importCost) return 'You do not have enough credits (' + c.balance + ').';
      return null;
    }

    function compute() {
      const p = S.page;
      const out = { checks: [], level: 'ok', cost: p.price, sell: null, r: null, rec: null, even: null, recMarkup: null, live: null, cannotImport: false };
      const { here } = locate();
      out.cannotImport = !!here && here.status !== 'draft';
      // Already live on eBay: what it earns at the price it is listed at, not at the markup of a new import.
      if (here && LOGIC.LIVE.has(here.status) && here.sellPrice && (!here.currency || here.currency === p.currency)) out.live = here;
      out.checks = LOGIC.buildChecks({ page: p, server: S.server, storeId: S.storeId, settings: S.fees, markup: S.markup, now: new Date(), market: currentMarket() });
      out.level = LOGIC.worstLevel(out.checks);
      if (p.price != null) {
        out.sell = out.live ? out.live.sellPrice : LOGIC.priceAtMarkup(p.price, S.markup);
        out.r = LOGIC.evaluate(p.price, out.sell, S.fees);
        out.rec = LOGIC.recommendedPrice(p.price, S.fees, S.fees.targetPct);
        out.even = LOGIC.breakEvenPrice(p.price, S.fees);
        out.recMarkup = out.rec == null ? null : LOGIC.markupToReach(p.price, out.rec);
      }
      return out;
    }

// Fills a store <select> (the product panel's or the bulk panel's) from ELMS's list of stores.
    function fillStores(select, sec) {
      const stores = (S.server && S.server.stores) || [];
      const sig = JSON.stringify(stores.map((s) => [s.id, s.label, s.amazonOk]));
      const { store } = locate();
      if (select.dataset.sig !== sig) {
        select.dataset.sig = sig;
        select.replaceChildren(...stores.map((s) => h('option', { value: s.id, text: s.label + (s.amazonOk === false ? ' (other Amazon site)' : '') })));
      }
      if (store) select.value = store.id;
      sec.style.display = stores.length > 1 ? 'block' : 'none';
    }
    const renderStores = () => fillStores(storeSelect, storeSec);

    function renderMoney(c) {
      const rows = [];
      const row = (label, value, cls) => h('div', { class: 'row' + (cls ? ' ' + cls : '') }, h('span', { text: label }), h('span', { text: value }));
      if (c.r) {
        const m = S.markup === '' ? 0 : Number(S.markup) || 0;
        rows.push(row('Amazon price', money(c.cost)));
        rows.push(row(c.live ? 'Your live eBay price' : 'Your eBay price (' + m + '% markup)', money(c.sell)));
        rows.push(row('eBay fees', '-' + money(c.r.fees)));
        const keep = h('div', { class: 'row keep ' + (c.r.profit < 0 ? 'loss' : 'good') }, h('span', { text: 'You keep' }), h('span', { text: money(c.r.profit) + ' · ' + c.r.margin.toFixed(1) + '%' }));
        rows.push(keep);
        if (c.even != null) rows.push(row('Break-even price', money(c.even)));
        if (c.rec != null) rows.push(row(S.fees.targetPct + '% profit needs', money(c.rec) + ' (' + c.recMarkup + '% markup)'));
      } else {
        rows.push(h('div', { class: 'note', text: 'No price was found, so the profit cannot be worked out.' }));
      }
      moneyBox.replaceChildren(...rows);
      if (c.recMarkup != null && c.r) {
        useBtn.style.display = '';
        useBtn.textContent = 'Use ' + c.recMarkup + '%';
        useBtn.disabled = Number(S.markup) === c.recMarkup;
      } else useBtn.style.display = 'none';
      markupSec.style.display = c.cannotImport ? 'none' : 'block';
      if (document.activeElement !== markupInput && shadow.activeElement !== markupInput) markupInput.value = S.markup;
      markupHint.textContent = 'eBay fees ' + S.fees.feePct + '%' + (S.fees.adPct ? ' + ' + S.fees.adPct + '% promoted' : '') + ' + ' + money(S.fees.fixed) + ' per order. Change them in the extension popup.';
    }

    function renderChecks(c) {
      const items = [];
      if (!S.connected) items.push(h('li', { class: 'info' }, h('i', { text: 'i' }), h('span', { text: 'Connect your ELMS account (click the ELMS icon in the toolbar) to see what you already have, VeRO words and your credits.' })));
      else if (S.serverState === 'loading' && !S.server) items.push(h('li', { class: 'info' }, h('i', { text: 'i' }), h('span', { text: 'Checking with ELMS…' })));
      else if (S.serverState === 'error') items.push(h('li', { class: 'info' }, h('i', { text: 'i' }), h('span', { text: 'ELMS could not be checked: ' + S.serverError })));
      const icon = { bad: '✕', warn: '!', info: 'i', ok: '✓' };
      c.checks.forEach((k) => items.push(h('li', { class: k.level }, h('i', { text: icon[k.level] }), h('span', { text: k.text }))));
      checksList.replaceChildren(...items);
    }

    function renderActions() {
      const block = importBlock();
      const { here } = locate();
      const credits = S.server && S.server.credits;
      const price = credits ? ' · ' + LOGIC.costLabel(credits.importCost) : ''; // "Free" when it is free; nothing until ELMS has answered
      goBtn.disabled = S.busy || !!block;
      goBtn.textContent = S.busy ? 'Importing…' : here && here.status === 'draft' ? 'Refresh the draft' + price : 'Import to Drafts' + price;
      // Something to open in ELMS: the draft, or the live listing.
      openBtn.style.display = here ? 'block' : 'none';
      openBtn.textContent = here && here.status === 'draft' ? 'Open the draft in ELMS' : 'Open in ELMS';
      foot.textContent = credits ? (credits.unlimited ? 'Unlimited credits' : 'You have ' + credits.balance + ' credit' + (credits.balance === 1 ? '' : 's')) : '';
      goBtn.title = block || '';
    }

    function render() {
      if (S.mode === 'list') { renderList(); return; }
      const p = S.page;
      stack.style.display = S.mode === 'product' && p ? 'flex' : 'none';
      bulkPanel.className = 'panel';
      if (!p || S.mode !== 'product') return;
      const c = compute();
      const bad = c.checks.filter((k) => k.level === 'bad' || k.level === 'warn').length;
      const lossy = !!(c.r && c.r.profit < 0);
      chip.className = 'chip ' + (S.connected ? c.level : '');
      // A loss is only a warning: the chip says "N warnings" (amber) instead of a red "Loss"; the amount is in the panel and the import is never blocked.
      chip.textContent = lossy
        ? '⚠ ' + bad + (bad === 1 ? ' warning' : ' warnings')
        : (c.r ? 'Profit ' + money(c.r.profit) : 'ELMS') + (bad ? ' · ' + bad + (bad === 1 ? ' warning' : ' warnings') : '');
      panel.className = 'panel' + (S.open ? ' open' : '');
      renderStores();
      renderMoney(c);
      renderMarket();
      renderChecks(c);
      renderActions();
      if (S.open) loadMarket();
    }

    // A page with a list of products: the chip and the bulk panel.
    function renderList() {
      stack.style.display = 'flex';
      panel.className = 'panel';
      const n = picked.size;
      chip.className = 'chip ' + (n ? 'ok' : '');
      chip.textContent = n ? n + (n === 1 ? ' product selected' : ' products selected') : 'Bulk import';
      bulkPanel.className = 'panel' + (S.open ? ' open' : '');
      fillStores(bulkStoreSelect, bulkStoreSec);
      renderBulk();
    }

    // ----- bulk import: pick products on a list page -----
    const picked = new Set();      // ASINs ticked
    const knownRows = new Map();   // ASIN -> what ELMS already has for it (rows of listings)
    const askedAsins = new Set();
    let knownRetryAt = 0;

    // A card's state for the chosen store: off / on, or draft / live when ELMS already has the product there.
    function pickState(asin) {
      const { here } = LOGIC.locate({ stores: (S.server && S.server.stores) || [], existing: knownRows.get(asin) || [] }, S.storeId);
      if (!here) return picked.has(asin) ? 'on' : 'off';
      return here.status === 'draft' ? 'draft' : 'live';
    }
    const PICK_TEXT = { off: '+ ELMS', on: '✓ ELMS', draft: 'In Drafts', live: 'In ELMS' };
    const PICK_TITLE = { off: 'Select this product for bulk import', on: 'Selected: click to remove', draft: 'Already in your ELMS Drafts', live: 'Already on eBay (or on its way) in ELMS' };

    function paintPicks() {
      document.querySelectorAll('.elms-pick').forEach((pick) => {
        const st = pickState(pick.dataset.asin);
        if (pick.dataset.state === st) return; // write only what changed: the page is watched for changes
        pick.dataset.state = st;
        pick.className = 'elms-pick ' + st;
        pick.textContent = PICK_TEXT[st];
        pick.title = PICK_TITLE[st];
        pick.setAttribute('aria-checked', String(st === 'on'));
      });
    }

    async function loadKnown(asins) {
      if (!S.connected || Date.now() < knownRetryAt) return;
      asins.forEach((a) => askedAsins.add(a));
      for (let i = 0; i < asins.length; i += 100) {
        const chunk = asins.slice(i, i + 100);
        const r = await send({ type: 'ELMS_API', method: 'POST', path: '/api/extension/known', body: { asins: chunk } });
        if (!r.success) { chunk.forEach((a) => askedAsins.delete(a)); knownRetryAt = Date.now() + 30000; return; }
        const rows = new Map();
        (r.result.known || []).forEach((k) => { if (!rows.has(k.asin)) rows.set(k.asin, []); rows.get(k.asin).push(k); });
        chunk.forEach((a) => knownRows.set(a, rows.get(a) || []));
      }
      picked.forEach((a) => { const st = pickState(a); if (st === 'draft' || st === 'live') picked.delete(a); }); // what ELMS has is not imported again
      paintPicks();
      render();
    }

    function scanCards() {
      ensurePickStyle();
      const fresh = [];
      for (const { el, asin } of findCards()) {
        let pick = el.querySelector(':scope > .elms-pick');
        if (!pick) {
          if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
          pick = document.createElement('div');
          pick.className = 'elms-pick';
          pick.setAttribute('role', 'checkbox');
          pick.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePick(pick.dataset.asin); }, true);
          el.prepend(pick);
        }
        pick.dataset.asin = asin;
        if (!askedAsins.has(asin)) fresh.push(asin);
      }
      paintPicks();
      if (fresh.length) loadKnown(fresh);
    }

    // Credits and stores for a list page (no product to ask about).
    async function loadListInfo() {
      if (!S.connected || S.server || S.serverState === 'loading') return;
      S.serverState = 'loading';
      const r = await send({ type: 'ELMS_CHECK', payload: { amazonUrl: location.href } });
      if (r.success) {
        S.server = r.result;
        S.serverState = 'ok';
        try { chrome.storage.local.set({ appUrl: r.result.appUrl }); } catch (_) { /* only remembered for opening ELMS pages */ }
      } else {
        S.serverState = 'error';
        S.serverError = r.error || 'ELMS could not be reached.';
      }
      paintPicks();
      render();
    }

    function togglePick(asin) {
      if (S.bulk.running) return;
      const st = pickState(asin);
      if (st === 'draft' || st === 'live') { show(PICK_TITLE[st] + '.', 'busy'); return; }
      if (picked.has(asin)) picked.delete(asin);
      else if (picked.size >= MAX_PICK) { show('Up to ' + MAX_PICK + ' products at a time.', 'err'); return; }
      else picked.add(asin);
      paintPicks();
      render();
    }

    // Why the selection cannot be imported (or null).
    function bulkBlock() {
      if (!S.connected) return 'Connect your ELMS account first: click the ELMS icon in the Chrome toolbar and paste your Extension Key.';
      if (!picked.size) return 'Tick the products you want with the + ELMS badge on each one.';
      if (!S.server) return null;
      const { store } = locate();
      if (!S.server.stores.length && !storeless()) return 'Connect an eBay store in ELMS first.';
      if (store && store.amazonOk === false) return store.amazonMessage || 'This Amazon site does not match your store.';
      const c = S.server.credits;
      const need = picked.size * bulkPer(c);
      if (c && !c.unlimited && c.balance < need) return 'These ' + picked.size + ' products need ' + need + ' credits and you have ' + c.balance + '.';
      return null;
    }

    function renderBulk() {
      const n = picked.size;
      const c = S.server && S.server.credits;
      const per = bulkPer(c);
      const b = S.bulk;
      if (document.activeElement !== bulkMarkup && shadow.activeElement !== bulkMarkup) bulkMarkup.value = S.markup;
      bulkStats.textContent = n ? n + (n === 1 ? ' product' : ' products') + ' selected · ' + LOGIC.costLabel(n * per) : 'Tick the products you want with the + ELMS badge on each one.';
      bulkGo.disabled = b.running || !!bulkBlock();
      bulkGo.textContent = b.running ? 'Importing…' : n ? 'Import ' + n + (n === 1 ? ' product' : ' products') + ' · ' + LOGIC.costLabel(n * per) : 'Import selected products';
      bulkGo.title = b.running ? '' : (n ? bulkBlock() || '' : '');
      bulkAll.disabled = b.running;
      bulkClear.disabled = b.running || !n;
      const lines = [];
      if (b.total) {
        const finished = b.done + b.failed;
        lines.push(b.running ? finished + ' of ' + b.total + ' done' + (b.failed ? ' · ' + b.failed + ' failed' : '') : b.done + ' saved to your Drafts' + (b.failed ? ', ' + b.failed + ' failed' : '') + '.');
        if (b.note) lines.push(b.note);
        b.lines.slice(0, 5).forEach((l) => lines.push('• ' + l));
        if (b.lines.length > 5) lines.push('• and ' + (b.lines.length - 5) + ' more');
      }
      bulkProgress.textContent = lines.join('\n');
      bulkBarFill.style.width = b.total ? Math.min(100, Math.round(((b.done + b.failed) / b.total) * 100)) + '%' : '0';
      bulkBar.style.display = b.total ? 'block' : 'none';
      bulkFoot.textContent = c ? (c.unlimited ? 'Unlimited credits' : 'You have ' + c.balance + ' credit' + (c.balance === 1 ? '' : 's')) + ' · ELMS fetches the products (variant pictures are not included: import products with variants from their own page)' : '';
    }

    async function runBulk() {
      if (S.bulk.running) return;
      const block = bulkBlock();
      if (block) { show(block, 'err'); S.open = true; render(); return; }
      const asins = [...picked];
      const urls = asins.map((a) => location.origin + '/dp/' + a);
      const { store } = locate();
      const markup = S.markup === '' ? undefined : Number(S.markup);
      const common = { markupPercent: Number.isFinite(markup) ? markup : undefined, ebayAccountId: store ? store.id : undefined, source: 'extension' }; // "extension": ELMS charges the extension's own bulk price
      const b = (S.bulk = { running: true, total: urls.length, done: 0, failed: 0, lines: [], note: 'Sending the products to ELMS…' });
      render();
      try {
        const limits = await send({ type: 'ELMS_API', method: 'GET', path: '/api/fetch-product/limits' });
        if (!limits.success) throw new Error(limits.error || 'ELMS could not be reached.');
        if (limits.result.easyparserConfigured) {
          // Many products: ELMS fetches them in the background, so this page can be closed.
          const made = await send({ type: 'ELMS_API', method: 'POST', path: '/api/fetch-product/bulk-job', body: { amazonUrls: urls, ...common } });
          if (!made.success) throw new Error(made.error || 'The import could not be started.');
          const skipped = made.result.skipped || [];
          skipped.forEach((s) => b.lines.push(s.error));
          b.failed = skipped.length;
          b.note = 'ELMS is fetching the products. You can close this page: the import goes on.';
          render();
          const started = Date.now();
          for (;;) {
            await sleep(4000);
            const st = await send({ type: 'ELMS_API', method: 'GET', path: '/api/fetch-product/bulk-job/' + made.result.jobId });
            if (!st.success) { if (Date.now() - started > 120000) throw new Error(st.error || 'ELMS could not be reached.'); continue; }
            const job = st.result.job;
            b.done = job.done;
            b.failed = job.failed + skipped.length;
            b.lines = skipped.map((s) => s.error).concat((job.items || []).filter((i) => i.status === 'error').map((i) => i.error || 'A product could not be imported.'));
            render();
            if (job.status === 'done' || job.status === 'cancelled' || Date.now() - started > 30 * 60 * 1000) break;
          }
        } else {
          // A few products at a time, each request answered when its products are saved.
          const size = Math.max(1, Math.min(5, limits.result.bulkImportMax || 5));
          for (let i = 0; i < urls.length; i += size) {
            const r = await send({ type: 'ELMS_API', method: 'POST', path: '/api/fetch-product/bulk', body: { amazonUrls: urls.slice(i, i + size), ...common }, timeoutMs: 170000 });
            if (!r.success) throw new Error(r.error || 'ELMS could not be reached.');
            (r.result.results || []).forEach((x) => { if (x.success) b.done += 1; else { b.failed += 1; b.lines.push(x.error || 'A product could not be imported.'); } });
            render();
          }
        }
        b.note = '';
        show('✓ ' + b.done + ' saved to ELMS Drafts' + (b.failed ? '\n' + b.failed + ' failed' : ''), b.done ? 'ok' : 'err');
      } catch (e) {
        b.note = '';
        b.lines.push(e && e.message ? e.message : 'The import stopped.');
        show(e && e.message ? e.message : 'The import stopped.', 'err');
      } finally {
        b.running = false;
        // Ask ELMS again what it has now: what was saved shows as "In Drafts", what failed stays selectable.
        picked.clear();
        asins.forEach((a) => { askedAsins.delete(a); knownRows.delete(a); });
        knownRetryAt = 0;
        S.server = null;
        S.serverState = 'idle';
        paintPicks();
        render();
        loadListInfo().then(() => loadKnown(asins));
      }
    }

    // ----- the market on eBay (asked for when the panel is opened) -----
    const marketCache = new Map(); // "asin|store" -> { state: 'loading' | 'ok' | 'error', data?, error?, at }
    const EBAY_LINK = /^https:\/\/([a-z0-9-]+\.)*ebay\.[a-z.]+\//i;

    function marketKey() {
      const { store } = locate();
      return (S.page ? S.page.asin : '') + '|' + (store ? store.id : '');
    }

    function currentMarket() {
      const entry = S.page ? marketCache.get(marketKey()) : null;
      return entry && entry.state === 'ok' ? entry.data : null;
    }

    async function loadMarket() {
      if (!S.connected || !S.page || !S.server || S.mode !== 'product') return;
      const key = marketKey();
      const hit = marketCache.get(key);
      if (hit && (hit.state !== 'error' || Date.now() - hit.at < 60000)) return;
      marketCache.set(key, { state: 'loading', at: Date.now() });
      render();
      const { store } = locate();
      const r = await send({ type: 'ELMS_API', method: 'POST', path: '/api/extension/market', body: { storeId: store ? store.id : undefined, title: S.page.title, gtin: S.page.gtin || undefined }, timeoutMs: 40000 });
      marketCache.set(key, r.success ? { state: 'ok', data: r.result.market, at: Date.now() } : { state: 'error', error: r.error || 'ELMS could not be reached.', at: Date.now() });
      render();
    }

    function renderMarket() {
      const visible = !!(S.page && S.connected && S.server);
      marketSec.style.display = visible ? 'block' : 'none';
      if (!visible) return;
      const entry = marketCache.get(marketKey());
      const line = (label, value) => h('div', { class: 'row' }, h('span', { text: label }), h('span', { text: value }));
      const kids = [];
      if (!entry || entry.state === 'loading') kids.push(h('div', { class: 'hint', text: 'Looking at eBay…' }));
      else if (entry.state === 'error') kids.push(h('div', { class: 'hint', text: 'Could not look at eBay: ' + entry.error }));
      else if (!entry.data.available) kids.push(h('div', { class: 'hint', text: entry.data.message || 'eBay prices are not available right now.' }));
      else if (!entry.data.count) kids.push(h('div', { class: 'hint', text: 'No similar listing found on eBay.' }));
      else {
        const m = entry.data;
        const fm = (n) => LOGIC.formatMoney(n, m.currency);
        kids.push(line('Similar listings', m.total + (m.sellers ? ' · ' + m.sellers + (m.sellers === 1 ? ' seller' : ' sellers') : '')));
        kids.push(line('Lowest', fm(m.min)));
        kids.push(line('Typical', fm(m.median)));
        kids.push(line('Highest', fm(m.max)));
        (m.cheapest || []).forEach((c) => {
          const label = fm(c.price + (c.shipping || 0)) + ' · ' + (c.seller || 'seller') + ' · ' + c.title;
          kids.push(c.url && EBAY_LINK.test(c.url) ? h('a', { class: 'mk-link', href: c.url, target: '_blank', rel: 'noopener noreferrer', text: label }) : h('div', { class: 'mk-link', text: label }));
        });
        kids.push(h('div', { class: 'hint', text: m.exact ? 'Matched by barcode: the same product. Prices include delivery when the seller charges it.' : 'Matched by title words: similar products can be included, so open the listings to check.' }));
      }
      marketBody.replaceChildren(...kids);
    }

    // ----- the import -----
    async function runImport(source) {
      if (S.busy) return;
      if (S.mode === 'list') { S.open = !S.open; render(); return; }
      if (!isProductPage()) { show('Open an Amazon product page to import it.', 'err'); return; }
      await refresh(false);
      const block = importBlock();
      if (block) { show(block, 'err'); S.open = true; render(); return; }
      const { store, here } = locate();
      if (source === 'logo' && here && here.status === 'draft' && Date.now() > S.confirmUntil) {
        S.confirmUntil = Date.now() + 6000;
        show('This product is already in your Drafts. Press the button again within 6 seconds to refresh it (' + LOGIC.costLabel(S.server.credits ? S.server.credits.importCost : 1) + ').', 'busy');
        return;
      }
      S.busy = true;
      logo.disabled = true;
      render();
      try {
        show('Reading this Amazon page…', 'busy');
        const product = await extractWithVariants((message) => show(message, 'busy'));
        if (!product.asin || !product.title) throw new Error('Amazon product page not detected. Open a product page and try again.');
        show('Sending product to ELMS…', 'busy');
        const markup = S.markup === '' ? undefined : Number(S.markup);
        const response = await send({ type: 'ELMS_IMPORT_PRODUCT', product, amazonUrl: location.href, markupPercent: Number.isFinite(markup) ? markup : undefined, ebayAccountId: store ? store.id : undefined });
        if (!response.success) {
          if (response.code === 'already_listed') loadServer(true);
          throw new Error(response.error || 'Could not import this product.');
        }
        dot.style.display = 'block';
        const result = response.result || {};
        const saved = result.product || product;
        const variantCount = (saved.variants || product.variants || []).length;
        const left = result.creditsLeft;
        show('✓ Saved to ELMS Drafts\n' + (saved.asin || product.asin) + ' · ' + (saved.images ? saved.images.length : 0) + ' images' + (variantCount ? ' · ' + variantCount + ' variants' : '') + (left != null ? '\n' + left + ' credit' + (left === 1 ? '' : 's') + ' left' : '') + importLossNote(), 'ok');
        cache.delete(product.asin);
        loadServer(true);
        if (S.autoOpen && result.draft && result.draft.id) openInElms(result.appUrl, '/draft?open=' + encodeURIComponent(result.draft.id));
      } catch (e) {
        show(e && e.message ? e.message : 'Import failed.', 'err');
      } finally {
        S.busy = false;
        logo.disabled = false;
        render();
      }
    }

    function openInElms(appUrl, path) {
      const base = String(appUrl || (S.server && S.server.appUrl) || 'https://elmstool.com').replace(/\/+$/, '');
      send({ type: 'ELMS_OPEN_URL', url: base + path });
    }

    // ----- wiring -----
    logo.addEventListener('click', () => runImport('logo'));
    goBtn.addEventListener('click', () => runImport('panel'));
    chip.addEventListener('click', () => { S.open = !S.open; render(); });
    closeBtn.addEventListener('click', () => { S.open = false; render(); });
    openBtn.addEventListener('click', () => {
      const { here } = locate();
      if (!here) return;
      openInElms(null, here.status === 'draft' ? '/draft?open=' + encodeURIComponent(here.id) : '/listing');
    });
    storeSelect.addEventListener('change', () => {
      S.storeId = storeSelect.value;
      S.confirmUntil = 0;
      try { chrome.storage.local.set({ storeId: S.storeId }); } catch (_) { /* kept for this page only */ }
      render();
    });
    markupInput.addEventListener('input', () => {
      S.markup = markupInput.value.trim();
      try { chrome.storage.local.set({ markup: S.markup }); } catch (_) { /* kept for this page only */ }
      render();
    });
    useBtn.addEventListener('click', () => {
      const c = compute();
      if (c.recMarkup == null) return;
      S.markup = String(c.recMarkup);
      markupInput.value = S.markup;
      try { chrome.storage.local.set({ markup: S.markup }); } catch (_) { /* kept for this page only */ }
      render();
    });

    bulkClose.addEventListener('click', () => { S.open = false; render(); });
    bulkGo.addEventListener('click', () => runBulk());
    bulkAll.addEventListener('click', () => {
      document.querySelectorAll('.elms-pick').forEach((pick) => { if (picked.size < MAX_PICK && pickState(pick.dataset.asin) === 'off') picked.add(pick.dataset.asin); });
      paintPicks();
      render();
    });
    bulkClear.addEventListener('click', () => { picked.clear(); paintPicks(); render(); });
    bulkStoreSelect.addEventListener('change', () => {
      S.storeId = bulkStoreSelect.value;
      try { chrome.storage.local.set({ storeId: S.storeId }); } catch (_) { /* kept for this page only */ }
      paintPicks();
      render();
    });
    bulkMarkup.addEventListener('input', () => {
      S.markup = bulkMarkup.value.trim();
      try { chrome.storage.local.set({ markup: S.markup }); } catch (_) { /* kept for this page only */ }
      render();
    });

    // The popup (or another tab) changed a setting.
    try {
      chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'local') return;
        const keys = Object.keys(changes);
        if (!keys.some((k) => ['extensionKey', 'sessionToken', 'markup', 'storeId', 'fees', 'autoOpen', 'skipVariants'].includes(k))) return;
        const wasConnected = S.connected;
        Object.assign(S, await readSettings());
        dot.style.display = S.connected && S.hasSession ? 'block' : 'none';
        if (S.connected && !wasConnected) { lastSig = ''; refresh(true); } else render();
      });
    } catch (_) { /* no live settings */ }

    // Amazon changes the page without loading a new one (a colour or size is picked, the price appears): look again when it settles.
    let timer = null;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => refresh(false), 1000); };
    try { new MutationObserver(later).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (_) { /* the page is read once */ }
    window.addEventListener('popstate', later);

    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'ELMS_TRIGGER_IMPORT') runImport('shortcut');
      return false;
    });

    (async () => {
      Object.assign(S, await readSettings());
      dot.style.display = S.connected && S.hasSession ? 'block' : 'none';
      await refresh(true);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installFloatingImporter, {once:true});
  else installFloatingImporter();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ELMS_GET_PRODUCT') return false;
    extractWithVariants().then((product) => sendResponse({ success: true, product })).catch((e) => sendResponse({ success: false, error: e?.message || 'Could not extract Amazon product.' }));
    return true;
  });
})();
