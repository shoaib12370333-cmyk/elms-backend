# ELMS Order Sync

Chrome MV3 extension that fills in an order's delivery date and buying cost on ELMS automatically, right after you place the matching order on Amazon yourself.

Unlike the old, now-removed Auto Order extension, this one **never automates the Amazon purchase** - it never clicks, fills in an address, or submits anything on Amazon. It only reads the confirmation page's own text after a human (you) completed checkout, the same way you'd read it, so it carries none of that feature's Amazon bot-detection / account-ban risk.

## User flow
1. In ELMS, open Settings and copy the personal **ELMS Extension Key** (the same one the Amazon Importer and, previously, Auto Order used).
2. Paste that key into this extension once.
3. On the Orders page, click the **AMAZON** link on the order you're about to place - it opens the product on Amazon in a new tab, with the order's id tagged onto the tab (not something Amazon itself ever sees or stores).
4. Complete the purchase on Amazon in that same tab, exactly as you normally would.
5. Once Amazon shows its own order confirmation page, the extension reads the order total and the estimated delivery date off that page and saves them onto the ELMS order - the same fields "Mark as ordered" fills in by hand.

## How the order is matched
Amazon's own checkout pages never carry ELMS's link parameter forward on their own, so the association between "this browser tab" and "this ELMS order" is kept in `chrome.storage.session` (background.js), keyed by tab id - set the moment the AMAZON link is opened, read again once the confirmation page loads, and cleared either once used or when the tab is closed. Opening the checkout in a different tab than the one ELMS's link opened breaks this (a known, accepted limitation, not a silent wrong-order risk: with no matching tab record, nothing is saved at all).

## What it reads, and what it never does
- Reads: the order total (`readCheckoutTotal`) and a best-effort estimated delivery date (`readDeliveryDate`) from the confirmation page's own text - both best-effort; an unreadable total means nothing is saved for that order, never a guess.
- Never reads or touches: the buyer's address, payment details, or anything before the confirmation page.
- Never clicks a button, fills a form field, or submits anything on Amazon.

## Amazon sites supported
Same set as the ELMS Amazon Importer: `.com`, `.co.uk`, `.ca`, `.de`, `.fr`, `.it`, `.es`, `.in`, `.com.au`.
