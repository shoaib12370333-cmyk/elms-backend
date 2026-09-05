require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { connectDB } = require('./db');

const fetchProductRoute = require('./routes/fetchProduct');
const fetchVariantRoute = require('./routes/fetchVariant');
const listOnEbayRoute = require('./routes/listOnEbay');
const listingsRoute = require('./routes/listings');
const importsRoute = require('./routes/imports');
const ordersRoute = require('./routes/orders');
const stockCheckRoute = require('./routes/stockCheck');
const authRoute = require('./routes/auth');
const ebayConnectRoute = require('./routes/ebayConnect');
const sellerSettingsRoute = require('./routes/sellerSettings');
const adminRoute = require('./routes/admin');
const supportTicketsRoute = require('./routes/supportTickets');
const seedAdminRoute = require('./routes/seedAdmin');
const paymentsRoute = require('./routes/payments');
const paddleWebhookRoute = require('./routes/paddleWebhook');
const { startStockMonitor } = require('./jobs/stockMonitor');
const { startScheduledPublisher } = require('./jobs/scheduledPublisher');
const { startOrderSync } = require('./jobs/orderSync');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// IMPORTANT: the Paddle webhook needs the raw (unparsed) request body to
// verify its signature - it's registered here, BEFORE the global
// express.json() below, with its own express.raw() middleware. If this were
// registered after express.json(), the body would already be parsed to an
// object and Paddle's signature check would fail.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), paddleWebhookRoute);

app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Google sign-in and current user
app.use('/api/auth', authRoute);

// Per-user eBay account connection (OAuth "Connect eBay" flow)
app.use('/api/ebay-connect', ebayConnectRoute);

// Per-user eBay business policy settings
app.use('/api/seller-settings', sellerSettingsRoute);

// Amazon product fetch route
app.use('/api/fetch-product', fetchProductRoute);

// Variant fetch route (used when the user selects a variant)
app.use('/api/fetch-variant', fetchVariantRoute);

// eBay listing route (used by the Publish to eBay button)
app.use('/api/list-on-ebay', listOnEbayRoute);

// Saved listings (Live Listings page)
app.use('/api/listings', listingsRoute);

// Import history
app.use('/api/imports', importsRoute);

// Orders
app.use('/api/orders', ordersRoute);

// Manual stock check trigger (for testing the stock monitor)
app.use('/api/stock-check', stockCheckRoute);

// Admin Panel (users, credits, stock-check intervals, tickets)
app.use('/api/admin', adminRoute);

// Support tickets (user-facing: create/view own tickets)
app.use('/api/support-tickets', supportTicketsRoute);

// One-time admin seeding utility - remove after creating your first admin
app.use('/api/seed-admin', seedAdminRoute);

// Credit purchases: list plans, checkout, purchase history (the webhook
// above is separate since it needs raw body parsing)
app.use('/api/payments', paymentsRoute);

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Server is running: http://localhost:${PORT}`);
    startStockMonitor();
    startScheduledPublisher();
    startOrderSync();
  });
}

start();
