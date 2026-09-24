# ELMS Amazon Importer

Chrome MV3 extension that reads the product currently open on an Amazon product page and imports the normalized data into ELMS Drafts.

## User flow
1. In ELMS, open Settings and copy the personal **ELMS Extension Key**.
2. Paste that key into the extension once.
3. Open an Amazon product page.
4. Click **Import current Amazon product**.

The extension does **not** expose an editable backend URL and does **not** have a Fetch by Link feature. The API endpoint is centrally controlled by the ELMS Admin Panel and bootstrapped from the canonical ELMS backend.

Product images are limited to Amazon's product gallery/A+ areas and video thumbnails/player posters are filtered out.

## Look (v3.3.1)
The ELMS wordmark is the extension's logo everywhere: the toolbar icon, the popup header and the button on Amazon pages (`icon-*.png`, `logo-wordmark.png`, `logo.png`).

## What it reads (v3.3)
- Title, description, bullet points, price, brand, categories and **every item specification** on the page.
- **All gallery pictures** of the product, full size.
- **Variants** (colour, size, ...): for each one its ASIN, what makes it different (dimensions), its **own title**, its **own pictures**, price and stock. The colour / size picker's data is read from the page, and each variant's own product page is opened in the background (same Amazon site, at most 30 variants, three at a time, about 25 seconds at most) to get its pictures and title. If Amazon asks for a captcha, reading variants stops and the variants keep their picker picture and name.
