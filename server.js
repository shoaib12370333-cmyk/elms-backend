require('dotenv').config();
require('express-async-errors'); // must be required before routes are defined - see comment below

const express = require('express');
const path = require('path');
const cors = require('cors');

const { connectDB } = require('./db');
const { applyActionCostOverridesOnStartup } = require('./models/settingsModel');

const fetchProductRoute = require('./routes/fetchProduct');
const browserImportRoute = require('./routes/browserImport');
const fetchVariantRoute = require('./routes/fetchVariant');
const listOnEbayRoute = require('./routes/listOnEbay');
const listingsRoute = require('./routes/listings');
const importsRoute = require('./routes/imports');
const ordersRoute = require('./routes/orders');
const stockCheckRoute = require('./routes/stockCheck');
const authRoute = require('./routes/auth');
const ebayConnectRoute = require('./routes/ebayConnect');
const ebayAccountsRoute = require('./routes/ebayAccounts');
const sellerSettingsRoute = require('./routes/sellerSettings');
const adminRoute = require('./routes/admin');
const supportTicketsRoute = require('./routes/supportTickets');
const researchToolsRoute = require('./routes/researchTools');
const notificationsRoute = require('./routes/notifications');
const systemNotificationsRoute = require('./routes/systemNotifications');
const dashboardRoute = require('./routes/dashboard');
const messageSnippetsRoute = require('./routes/messageSnippets');
const seedAdminRoute = require('./routes/seedAdmin');
const paymentsRoute = require('./routes/payments');
const paddleWebhookRoute = require('./routes/paddleWebhook');
const ebayAccountDeletionRoute = require('./routes/ebayAccountDeletion');
const ebayOrderNotificationRoute = require('./routes/ebayOrderNotification');
const { startStockMonitor } = require('./jobs/stockMonitor');
const { startScheduledPublisher } = require('./jobs/scheduledPublisher');
const { startOrderSync } = require('./jobs/orderSync');
const { startConversationSync } = require('./jobs/conversationSync');
const { startPublishQueue, runPublishQueue } = require('./jobs/publishQueue');

const app = express();

// Serve the bundled ELMS frontend when this deployment includes frontend/index.html.
app.use(express.static(path.join(__dirname, 'frontend')));
const PORT = process.env.PORT || 3000;

// Restrict cross-origin requests to our own frontend(s) only, instead of
// allowing every origin (the previous app.use(cors()) with no options
// reflects any request's Origin header, effectively allowing anyone).
// FRONTEND_URL is the same env var already used elsewhere for OAuth
// redirects; ALLOWED_ORIGINS can hold a comma-separated list of any
// additional origins (e.g. a custom domain) if needed.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : []),
].filter(Boolean);
const envExtensionOrigin = process.env.ELMS_EXTENSION_ID
  ? `chrome-extension://${process.env.ELMS_EXTENSION_ID}`
  : null;
const allowDevelopmentExtensions = process.env.NODE_ENV !== 'production';

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no Origin header (e.g. server-to-server calls,
    // curl, Postman) - browsers always send Origin for cross-origin fetches.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Chrome extension origins are not a useful authentication boundary: an
    // extension can only reach protected ELMS endpoints after presenting a
    // valid ELMS session/extension key. Allow the browser-extension origin
    // here so the extension can bootstrap (including its first connection)
    // without requiring a server redeploy whenever its Chrome ID changes.
    // The Admin Panel / ELMS_EXTENSION_ID setting is still retained as a
    // deployment preference, but it is not used as the only CORS gate.
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }

    // In production an explicitly configured extension origin remains
    // supported as an additional allowlist entry.
    if (envExtensionOrigin && origin === envExtensionOrigin) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
}));

// IMPORTANT: the Paddle webhook needs the raw (unparsed) request body to
// verify its signature - it's registered here, BEFORE the global
// express.json() below, with its own express.raw() middleware. If this were
// registered after express.json(), the body would already be parsed to an
// object and Paddle's signature check would fail.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), paddleWebhookRoute);

// Same reasoning for eBay's order notification webhook - its ECDSA
// signature is computed over the exact raw bytes eBay sent, so this must
// also see the unparsed body (see services/ebayNotificationVerifyService.js).
// The GET verification request has no body, so express.raw() is a no-op for it.
app.use('/api/ebay/order-notification', express.raw({ type: 'application/json' }), ebayOrderNotificationRoute);

// Marketplace Account Deletion notifications are also signed by eBay. Keep
// the raw body available for signature verification before express.json().
app.use('/api/ebay/account-deletion', express.raw({ type: 'application/json' }), ebayAccountDeletionRoute);

app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Google sign-in and current user
app.use('/api/auth', authRoute);

// Per-user eBay account connection (OAuth "Connect eBay" flow)
app.use('/api/ebay-connect', ebayConnectRoute);
app.use('/api/ebay-accounts', ebayAccountsRoute);

// Per-user eBay business policy settings
app.use('/api/seller-settings', sellerSettingsRoute);

// Amazon product fetch route
app.use('/api/fetch-product', fetchProductRoute);

// Browser extension import: accepts product data extracted from the user's
// currently open Amazon page; no Amazon server-side scraping is performed.
app.use('/api/browser-import', browserImportRoute);

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
app.use('/api/tools', researchToolsRoute);
app.use('/api/notifications', notificationsRoute);
app.use('/api/system-notifications', systemNotificationsRoute);
app.use('/api/dashboard', dashboardRoute);
app.use('/api/message-snippets', messageSnippetsRoute);

// One-time admin seeding utility - remove after creating your first admin
app.use('/api/seed-admin', seedAdminRoute);

// Credit purchases: list plans, checkout, purchase history (the webhook
// above is separate since it needs raw body parsing)
app.use('/api/payments', paymentsRoute);

// eBay Marketplace Account Deletion notification endpoint (required by
// eBay's Developer Program - see routes/ebayAccountDeletion.js for the
// challenge-response verification and notification handling)


// Global error handler - a safety net for any route that throws (or
// forgets its own try/catch) after this point in the middleware chain.
// Without this, an uncaught error in an async route handler can crash
// the entire server for every user, not just fail the one request. This
// must be registered LAST (after all routes) - Express only calls
// 4-argument middleware like this one for error handling.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Something went wrong on our end. Please try again.' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  }

  // Load any admin-saved credit-cost overrides before accepting traffic, so
  // a restart never silently reverts prices the admin changed in the panel
  // back to the code defaults.
  await applyActionCostOverridesOnStartup();

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

app.listen(PORT, () => {
    console.log(`Server is running: http://localhost:${PORT}`);
    startStockMonitor();
    startScheduledPublisher();
    startOrderSync();
    startConversationSync();
    startPublishQueue();
    runPublishQueue().catch((err) => console.error('[publish-queue] initial run failed:', err.message));
  });
}

start();
