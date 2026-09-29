// Runs on every Amazon page (manifest.json content_scripts). Most of the time there is no job for this tab at all -
// the seller's own ordinary Amazon browsing - so the very first thing this does on every load is ask background.js
// "is there a job for THIS tab", and does absolutely nothing else if the answer is no.
//
// Amazon's own markup changes by locale and by A/B test, and there is no way to verify these exact selectors against
// the live site from here. Every reader below is written with generous fallbacks and, more importantly, is built to
// report AO_BLOCKED/AO_ERROR rather than guess whenever something isn't exactly as expected - a wrong guess here
// spends the seller's real money. Selectors are grouped in SELECTORS so they are easy to adjust in one place once
// this has been run against the real site.

(function () {
  const SELECTORS = {
    productTitle: '#productTitle',
    addToCart: '#add-to-cart-button, input#add-to-cart-button',
    buyNow: '#buy-now-button, input#buy-now-button',
    quantitySelect: '#quantity, select[name="quantity"]',
    merchantInfo: '#merchant-info, #tabular-buybox, #buybox',
    placeOrderButton: '#submitOrderButtonId, input[name="place-your-order-button"], #placeYourOrder, button[name="placeYourOrder"]',
    proceedToCheckout: '#sc-buy-box-ptc-button, input[name="proceedToRetailCheckout"], #hlb-ptc-btn-native, #attach-sidesheet-checkout-button',
    giftOption: '#gift-options-checkbox, input[name="gift-option"], input[id*="gift-option" i]',
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A small random pause before each action - never a substitute for a real safety check, just closer to how a
  // person actually clicks through a page than an instant, mechanical burst of clicks would be.
  const humanPause = () => sleep(400 + Math.floor(Math.random() * 900));
  const money = (s) => { const m = String(s || '').match(/[\$£€]\s?([\d,]+\.\d{2})/); return m ? Number(m[1].replace(/,/g, '')) : null; };
  const visibleText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const pageText = () => document.body ? document.body.innerText : '';
  const qs = (sel) => document.querySelector(sel);
  const qsAll = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------- page-type detection
  function isCaptchaPage() {
    return /\/errors\/validateCaptcha/i.test(location.pathname)
      || !!qs('form[action*="validateCaptcha"]')
      || /enter the characters you see below/i.test(pageText());
  }
  function isSignInPage() {
    return /\/ap\/signin/i.test(location.pathname) || !!qs('#ap_email, #ap_password');
  }
  function isTwoFactorPage() {
    return /\/ap\/(mfa|cvf)/i.test(location.pathname) || !!qs('#auth-mfa-otpcode, #cvf-input-code, #auth-mfa-remember-device');
  }
  function isOrderConfirmationPage() {
    if (/thankyou|thank-you|order-confirm|\/spc\/confirmation/i.test(location.pathname)) return true;
    return /thanks,?\s*your order has been placed|order confirmed/i.test(pageText());
  }
  function isCheckoutReviewPage() {
    return !!qs(SELECTORS.placeOrderButton) || /\/gp\/buy\/|\/checkout\/|\/spc\//i.test(location.pathname);
  }
  function isCartPage() {
    return /\/gp\/cart\/|\/cart\//i.test(location.pathname) || !!qs('#sc-active-cart, #activeCartViewForm');
  }
  function isProductPage() {
    return /\/(?:dp|gp\/product|product)\/[A-Z0-9]{10}/i.test(location.pathname) || !!qs(SELECTORS.productTitle);
  }

  function pageKind() {
    if (isCaptchaPage()) return 'captcha';
    if (isSignInPage()) return 'signin';
    if (isTwoFactorPage()) return 'twofactor';
    if (isOrderConfirmationPage()) return 'confirmation';
    if (isCheckoutReviewPage()) return 'checkout';
    if (isCartPage()) return 'cart';
    if (isProductPage()) return 'product';
    return 'unknown';
  }

  // ---------------------------------------------------------------- product page reading
  function readStock() {
    const btn = qs(SELECTORS.addToCart) || qs(SELECTORS.buyNow);
    if (btn && !btn.disabled) return true;
    if (/currently unavailable|out of stock|see all buying options/i.test(pageText().slice(0, 4000))) return false;
    return !!btn;
  }

  function readFulfilledByAmazon() {
    const box = qs(SELECTORS.merchantInfo);
    const text = visibleText(box) || pageText().slice(0, 6000);
    return /sold by amazon(\.com)?\b/i.test(text) && /ships from amazon(\.com)?\b/i.test(text);
  }

  // Finds a clickable variant option (a "twister" swatch/button) whose own text or title contains `wanted`
  // (case-insensitive substring). Amazon's variant widgets vary a lot; this only ever clicks something when the
  // match is unambiguous - anything else is left for a human (reported by the caller as needs_attention).
  function findVariantOption(wanted) {
    if (!wanted) return null;
    const needle = String(wanted).toLowerCase();
    const candidates = qsAll('#variation_color_name li, #variation_size_name li, #variation_style_name li, [id^="variation_"] li, [data-a-button-group] li');
    return candidates.find((li) => (li.getAttribute('title') || li.textContent || '').toLowerCase().includes(needle)) || null;
  }

  function setQuantity(quantity) {
    const sel = qs(SELECTORS.quantitySelect);
    if (!sel || !quantity || quantity <= 1) return;
    const option = Array.from(sel.options || []).find((o) => Number(o.value) === Number(quantity));
    if (option) { sel.value = option.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    // No matching option (a quantity higher than Amazon offers): left at the default: readCheckoutTotal() will
    // reflect however many actually made it into the order, and the total-vs-cap check still protects the seller.
  }

  // ---------------------------------------------------------------- checkout/review page reading
  function readCheckoutTotal() {
    const labelled = qsAll('*').find((el) => el.children.length === 0 && /order total|grand total/i.test(el.textContent || ''));
    if (labelled) {
      const near = labelled.closest('tr, li, div');
      const amount = money(near ? near.textContent : labelled.parentElement?.textContent);
      if (amount != null) return amount;
    }
    // Fallback: the largest currency-looking amount on the page tends to be the grand total (line items are smaller).
    const amounts = (pageText().match(/[\$£€]\s?[\d,]+\.\d{2}/g) || []).map((s) => money(s)).filter((n) => n != null);
    return amounts.length ? Math.max(...amounts) : null;
  }

  function addressMatches(expected) {
    if (!expected) return false;
    const text = pageText().slice(0, 8000);
    const postal = String(expected.postalCode || '').trim();
    return postal.length > 2 && text.includes(postal);
  }

  function readConfirmationOrderId() {
    const m = pageText().match(/\b(\d{3}-\d{7}-\d{7})\b/);
    return m ? m[1] : null;
  }

  // Amazon's optional "This is a gift" checkbox during checkout - selecting it keeps Amazon's prices off the
  // packing slip, which matters here since the buyer paying on eBay was never meant to see what this cost on
  // Amazon. Not every product/account shows this step, so finding nothing is not an error - it is just skipped.
  function findGiftOption() { return qs(SELECTORS.giftOption); }

  // ---------------------------------------------------------------- the actual flow, driven by background.js
  async function report(type, payload) { return chrome.runtime.sendMessage({ type, ...payload }); }

  // Manual mode (job.manualMode): before anything that clicks or types, wait here - polling AO_AWAIT_STEP, since a
  // service worker can be evicted at any moment and must not be relied on to hold a response open - until the
  // seller presses "Do it" for this exact step in the popup, or the job is stopped from there. Outside manual mode
  // this resolves immediately: the seller never even sees these steps happen.
  async function confirmStep(job, name, description) {
    if (!job.manualMode) return true;
    for (;;) {
      const res = await report('AO_AWAIT_STEP', { name, description });
      if (res?.stopped) return false;
      if (res?.proceed) return true;
      await sleep(1000);
    }
  }

  async function runProductStep(job) {
    if (readStock() === false) return report('AO_BLOCKED', { reason: 'This item shows as out of stock or unavailable.' });
    if (job.settings?.primeOnly && !readFulfilledByAmazon()) {
      return report('AO_BLOCKED', { reason: 'This item is not sold/fulfilled by Amazon, and the seller only allows those.' });
    }
    if (job.order.variant_details) {
      const option = findVariantOption(job.order.variant_details);
      if (!option) return report('AO_BLOCKED', { reason: `Could not find the ordered variant ("${job.order.variant_details}") on this page.` });
      if (!(await confirmStep(job, 'select_variant', `Select the variant: ${job.order.variant_details}`))) return;
      await humanPause();
      option.click();
      await humanPause();
    }
    setQuantity(job.order.quantity);
    await humanPause();
    const buyNow = qs(SELECTORS.buyNow);
    const addToCart = qs(SELECTORS.addToCart);
    await report('AO_STEP', { step: 'product_checked' });
    if (buyNow) {
      if (!(await confirmStep(job, 'click_buy_now', `Click "Buy Now" (quantity ${job.order.quantity || 1})`))) return;
      buyNow.click();
      return;
    }
    if (addToCart) {
      if (!(await confirmStep(job, 'click_add_to_cart', `Click "Add to Cart" (quantity ${job.order.quantity || 1})`))) return;
      addToCart.click();
      await humanPause();
      const ptc = qs(SELECTORS.proceedToCheckout);
      if (ptc) {
        if (!(await confirmStep(job, 'proceed_to_checkout', 'Click "Proceed to checkout"'))) return;
        await humanPause();
        ptc.click();
        return;
      }
      return report('AO_BLOCKED', { reason: 'Added to cart, but could not find a way to proceed to checkout.' });
    }
    return report('AO_BLOCKED', { reason: 'Could not find a Buy Now or Add to Cart button on this page.' });
  }

  async function runCartStep(job) {
    const ptc = qs(SELECTORS.proceedToCheckout);
    if (!ptc) return report('AO_BLOCKED', { reason: 'On the cart page, but could not find a way to proceed to checkout.' });
    if (!(await confirmStep(job, 'proceed_to_checkout', 'Click "Proceed to checkout"'))) return;
    await humanPause();
    ptc.click();
  }

  async function runCheckoutStep(job) {
    const addressOk = addressMatches(job.order.shipping_address);
    if (!(await confirmStep(job, 'confirm_address', addressOk
      ? 'The selected Amazon address matches the buyer\'s postal code - continue?'
      : 'The selected Amazon address does NOT match the buyer\'s postal code. Fix it by hand, then press Do it to re-check - or Stop.'))) return;
    if (!addressOk) {
      // The seller pressed "Do it" anyway without the address actually matching yet - read it again rather than
      // trusting the earlier read, exactly like re-checking after fixing it by hand.
      if (!addressMatches(job.order.shipping_address)) {
        return report('AO_BLOCKED', { reason: 'The Amazon account\'s selected address does not match the buyer\'s address. Add/select it by hand, then retry.' });
      }
    }

    const giftBox = findGiftOption();
    if (giftBox) {
      if (await confirmStep(job, 'gift_option', 'Mark this as a gift? (keeps Amazon\'s price off the packing slip)')) {
        giftBox.click();
        await humanPause();
      }
    }

    const total = readCheckoutTotal();
    const inStock = readStock() !== false; // most themes still show availability on the review page too
    const fulfilledByAmazon = readFulfilledByAmazon() || !job.settings?.primeOnly;
    if (!(await confirmStep(job, 'confirm_seller', `Sold/shipped by Amazon: ${fulfilledByAmazon ? 'yes' : 'NO'}. Total read from the page: ${total != null ? total : 'could not read it'}.`))) return;

    await report('AO_STEP', { step: 'reviewing' });
    const { pass, reason } = await report('AO_CHECKS', { total, inStock, fulfilledByAmazon });
    if (!pass) return report('AO_BLOCKED', { reason: reason || 'This order did not pass its final checks.' });
    const placeBtn = qs(SELECTORS.placeOrderButton);
    if (!placeBtn) return report('AO_BLOCKED', { reason: 'The checks passed, but the Place your order button could not be found.' });
    if (!(await confirmStep(job, 'click_place_order', 'Click "Place your order" - this spends real money.'))) return;
    await humanPause();
    placeBtn.click();
  }

  async function runConfirmationStep() {
    const amazonOrderId = readConfirmationOrderId();
    if (!amazonOrderId) return report('AO_BLOCKED', { reason: 'The order looks placed, but no Amazon order number could be read from the confirmation page.' });
    const amazonTotal = readCheckoutTotal();
    return report('AO_PLACED', { amazonOrderId, amazonTotal });
  }

  async function main() {
    let job;
    try { ({ job } = await chrome.runtime.sendMessage({ type: 'AO_ANNOUNCE' })); }
    catch (_) { return; } // background.js not ready / the extension was just reloaded - the next poll will retry
    if (!job) return; // no job for this tab: an ordinary Amazon page, leave it alone entirely

    const kind = pageKind();
    try {
      if (kind === 'captcha') return await report('AO_BLOCKED', { reason: 'Amazon showed a captcha.' });
      if (kind === 'signin') return await report('AO_BLOCKED', { reason: 'Amazon asked to sign in again.' });
      if (kind === 'twofactor') return await report('AO_BLOCKED', { reason: 'Amazon asked for a two-factor code.' });
      if (kind === 'confirmation') return await runConfirmationStep();
      if (kind === 'checkout') return await runCheckoutStep(job);
      if (kind === 'cart') return await runCartStep(job);
      if (kind === 'product') return await runProductStep(job);
      return await report('AO_BLOCKED', { reason: 'Landed on a page this extension does not recognize.' });
    } catch (err) {
      await report('AO_ERROR', { reason: err?.message || 'An unexpected error happened on this page.' });
    }
  }

  main();
})();
