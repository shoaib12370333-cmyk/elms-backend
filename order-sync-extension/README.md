# ELMS Order Sync

Chrome MV3 extension with two small, purely passive jobs while you place an order on Amazon yourself:
1. Shows the buyer's own address in a floating panel, ready to copy-paste onto Amazon's address form - you paste, you never retype it.
2. Once you finish checkout, fills in the order's delivery date and buying cost on ELMS automatically.

Unlike the old, now-removed Auto Order extension, this one **never automates the Amazon purchase** - it never clicks a button, fills in a form field, or submits anything on Amazon. Every keystroke and paste on Amazon is still yours. It only reads pages after you acted (the address panel is read-only display; the delivery date/cost step reads the confirmation page's own text after you completed checkout), so it carries none of that feature's Amazon bot-detection / account-ban risk - script-driven form-filling is exactly the kind of thing anti-fraud systems watch for, and this extension never does it.

## User flow
1. In ELMS, open Settings and copy the personal **ELMS Extension Key** (the same one the Amazon Importer and, previously, Auto Order used).
2. Paste that key into this extension once.
3. On the Orders page, click the **AMAZON** link on the order you're about to place - it opens the product on Amazon in a new tab, with the order's id tagged onto the tab (not something Amazon itself ever sees or stores).
4. A small "ELMS buyer address" panel appears in the corner of every Amazon page in that tab (collapsible) - press **Copy** next to any field, or **Copy full address**, then paste it onto Amazon's own address form yourself.
5. Complete the purchase on Amazon in that same tab, exactly as you normally would.
6. Once Amazon shows its own order confirmation page, the extension reads the order total and the estimated delivery date off that page and saves them onto the ELMS order - the same fields "Mark as ordered" fills in by hand. The address panel does not appear on the confirmation page; by then it's no longer needed.

## How the order is matched
Amazon's own checkout pages never carry ELMS's link parameter forward on their own, so the association between "this browser tab" and "this ELMS order" is kept in `chrome.storage.session` (background.js), keyed by tab id - set the moment the AMAZON link is opened, read again on every later page in that tab, and cleared either once the order is placed or when the tab is closed. Opening the checkout in a different tab than the one ELMS's link opened breaks this (a known, accepted limitation, not a silent wrong-order risk: with no matching tab record, nothing is shown or saved at all).

## What it reads, and what it never does
- Reads: the buyer's own shipping address and phone number already saved on the ELMS order (`GET /api/orders/:id`, display only); the order total (`readCheckoutTotal`) and a best-effort estimated delivery date (`readDeliveryDate`) from the confirmation page's own text once checkout is done - both best-effort, an unreadable total means nothing is saved for that order, never a guess.
- Never reads: anything Amazon has not already shown on the page (no payment details).
- Never clicks a button, fills a form field, selects an address, or submits anything on Amazon - copying a value to the clipboard is the only thing a button here ever does, and pasting it is always a step you take yourself.

## Amazon sites supported
Same set as the ELMS Amazon Importer: `.com`, `.co.uk`, `.ca`, `.de`, `.fr`, `.it`, `.es`, `.in`, `.com.au`.
