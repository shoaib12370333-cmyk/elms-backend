const { Paddle, Environment, EventName } = require('@paddle/paddle-node-sdk');

let paddleClient = null;

/**
 * Lazily creates the Paddle SDK client (so a missing PADDLE_API_KEY doesn't
 * crash the whole server at startup - only requests that actually need
 * Paddle will fail, with a clear error).
 */
function getPaddleClient() {
  if (paddleClient) return paddleClient;

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    throw new Error('PADDLE_API_KEY is not set in the .env file.');
  }

  const environment = process.env.PADDLE_ENV === 'sandbox' ? Environment.sandbox : Environment.production;
  paddleClient = new Paddle(apiKey, { environment });
  return paddleClient;
}

/**
 * Creates a Paddle transaction for a single price/quantity, with the ELMS
 * user's ID attached as custom data - this is what lets the webhook handler
 * know which user to credit when the payment completes.
 *
 * Returns the transaction ID, which the frontend uses to open Paddle.js's
 * checkout overlay (Paddle.Checkout.open({ transactionId })).
 */
async function createTransaction({ paddlePriceId, userId, userEmail }) {
  const paddle = getPaddleClient();

  const transaction = await paddle.transactions.create({
    items: [{ priceId: paddlePriceId, quantity: 1 }],
    customerEmail: userEmail,
    customData: { elmsUserId: userId },
  });

  return { transactionId: transaction.id };
}

/**
 * Verifies that a webhook request actually came from Paddle (not a forged
 * request), using the signing secret from your Paddle Notifications settings.
 * Returns the parsed event object on success, or throws on an invalid signature.
 *
 * @param {Buffer|string} rawBody - the raw (unparsed) request body
 * @param {string} signatureHeader - the "paddle-signature" request header
 */
function verifyAndParseWebhook(rawBody, signatureHeader) {
  const paddle = getPaddleClient();
  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new Error('PADDLE_WEBHOOK_SECRET is not set in the .env file.');
  }

  return paddle.webhooks.unmarshal(rawBody.toString(), webhookSecret, signatureHeader);
}

module.exports = { createTransaction, verifyAndParseWebhook, EventName };
