# ELMS Amazon Importer

Chrome MV3 extension that reads the product currently open on an Amazon product page and imports the normalized data into ELMS Drafts.

## User flow
1. In ELMS, open Settings and copy the personal **ELMS Extension Key**.
2. Paste that key into the extension once.
3. Open an Amazon product page.
4. Click **Import current Amazon product**.

The extension does **not** expose an editable backend URL and does **not** have a Fetch by Link feature. The API endpoint is centrally controlled by the ELMS Admin Panel and bootstrapped from the canonical ELMS backend.

Product images are limited to Amazon's product gallery/A+ areas and video thumbnails/player posters are filtered out.
