// Runs on every Amazon page (manifest.json content_scripts). Purely passive: it never clicks, fills or submits
// anything on Amazon - it only reads the confirmation page's own text after the seller placed the order themselves,
// the same way a person would read it, and only for a tab that was opened from one of ELMS's own "AMAZON" links.
// An ordinary Amazon page the seller is just browsing does nothing here at all.
(function () {
  const money = (s) => { const m = String(s || '').match(/[$£€]\s?([\d,]+\.\d{2})/); return m ? Number(m[1].replace(/,/g, '')) : null; };
  const pageText = () => (document.body ? document.body.innerText : '');
  const qsAll = (sel) => Array.from(document.querySelectorAll(sel));

  function isOrderConfirmationPage() {
    if (/thankyou|thank-you|order-confirm|\/spc\/confirmation/i.test(location.pathname)) return true;
    return /thanks,?\s*your order has been placed|order confirmed/i.test(pageText());
  }

  // Best effort, same technique as the page itself uses for its own order summary: the labelled "Order total" line,
  // else the largest currency-looking amount on the page (line items are smaller than the grand total).
  function readCheckoutTotal() {
    const labelled = qsAll('*').find((el) => el.children.length === 0 && /order total|grand total/i.test(el.textContent || ''));
    if (labelled) {
      const near = labelled.closest('tr, li, div');
      const amount = money(near ? near.textContent : labelled.parentElement?.textContent);
      if (amount != null) return amount;
    }
    const amounts = (pageText().match(/[$£€]\s?[\d,]+\.\d{2}/g) || []).map((s) => money(s)).filter((n) => n != null);
    return amounts.length ? Math.max(...amounts) : null;
  }

  // Amazon's confirmation page usually shows an estimated arrival ("Arriving Tuesday, Oct 7" / "Estimated delivery:
  // Oct 7, 2026"). Best effort only - this never blocks anything, so an unreadable date is simply left out (ELMS
  // keeps whatever delivery date, if any, was already there).
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function readDeliveryDate() {
    // Built as a plain "YYYY-MM-DD" string from the parsed month/day/year, never through `new Date(...)` - that
    // reads a month/day as local midnight, and converting it back with toISOString() can shift it a day either way
    // depending on the machine's own timezone, which would silently save the wrong delivery date.
    const m = pageText().match(/(?:arriving|estimated delivery:?)\s+(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
    if (!m) return null;
    const monthIndex = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const day = Number(m[2]);
    if (monthIndex === -1 || !day || day > 31) return null;
    const year = m[3] ? Number(m[3]) : new Date().getFullYear();
    return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function toast(message, ok = true) {
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = `position:fixed;top:16px;right:16px;z-index:2147483647;background:${ok ? '#0f172a' : '#b91c1c'};color:#fff;padding:12px 16px;border-radius:10px;font:600 13px/1.4 Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:320px;`;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  async function report(type, payload) {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res || !res.success) throw new Error(res?.error || 'The extension had no response.');
    return res.result;
  }

  async function main() {
    // A fresh visit from ELMS's own "AMAZON" link on an order: remember which order this browser TAB belongs to.
    // Amazon's own checkout pages never carry this parameter forward themselves, which is exactly why the
    // association has to live per-tab in the background script, not in the URL.
    const linkedOrderId = new URLSearchParams(location.search).get('elms_order');
    if (linkedOrderId) await report('ELMS_REMEMBER_TAB_ORDER', { orderId: linkedOrderId }).catch(() => {});

    if (!isOrderConfirmationPage()) return;

    let orderId;
    try { orderId = await report('ELMS_GET_TAB_ORDER'); } catch (_) { return; }
    if (!orderId) return; // an ordinary Amazon order, not opened from an ELMS order - nothing to do here

    const buyingPrice = readCheckoutTotal();
    if (buyingPrice == null) return; // could not read a total confidently enough to save - never guess
    const deliveryDate = readDeliveryDate();

    try {
      await report('ELMS_MARK_ORDERED', { orderId, deliveryDate, buyingPrice });
      await report('ELMS_FORGET_TAB_ORDER').catch(() => {});
      toast(`ELMS: saved this order's buying cost ($${buyingPrice})${deliveryDate ? ' and delivery date' : ''}.`);
    } catch (err) {
      toast(`ELMS could not save this order (${err?.message || 'unknown error'}) - enter it by hand in Orders instead.`, false);
    }
  }

  main();
})();
