const compression = require('compression');

/**
 * gzip for the API's answers. The lists (listings, orders ...) are big JSON that shrinks to a fraction of its size, and nothing
 * compressed them before. Small answers (under 1 KB) are sent as they are; a request can opt out with the header `x-no-compression`.
 */
module.exports = compression({
  threshold: 1024,
  filter: (req, res) => (req.headers['x-no-compression'] ? false : compression.filter(req, res)),
});
