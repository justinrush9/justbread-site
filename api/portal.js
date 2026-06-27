/**
 * JustBread — Customer Portal Endpoint
 * ===========================================
 * POST /api/portal
 *
 * Looks up a Stripe customer by email, then creates a Billing Portal
 * session so they can self-serve: pause, cancel, update payment method.
 *
 * Request body (JSON):
 *   { email: "customer@example.com" }
 *
 * Success response:
 *   { url: "https://billing.stripe.com/session/..." }
 *
 * Error responses:
 *   404 { error: "No customer found for that email." }
 *   400 { error: "email is required" }
 *   500 { error: "..." }
 *
 * Deploy notes:
 * - Uses the same STRIPE_SECRET_KEY env var as checkout.js
 * - Customer Portal must be configured in Stripe Dashboard first:
 *   Dashboard → Settings → Billing → Customer portal
 *   Enable: cancel subscriptions, pause subscriptions, update payment method
 *   Set return URL to: https://justbread.shop/manage/
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const ALLOWED_ORIGINS = [
  'https://justbread.shop',
  'https://www.justbread.shop',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'email is required' });
  }

  try {
    // Look up the customer by email
    const customers = await stripe.customers.list({
      email: email.toLowerCase().trim(),
      limit: 1,
    });

    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'No customer found for that email.' });
    }

    const customer = customers.data[0];

    // Verify they have at least one active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1,
    });

    // Also check for trialing or past_due (still manageable)
    let hasSubscription = subscriptions.data.length > 0;
    if (!hasSubscription) {
      const other = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'past_due',
        limit: 1,
      });
      hasSubscription = other.data.length > 0;
    }

    if (!hasSubscription) {
      return res.status(404).json({
        error: 'No active subscription found for that email. If you recently cancelled, your subscription may no longer be accessible here.',
      });
    }

    // Create a portal session
    // return_url is where they land after they're done in the portal
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: 'https://justbread.shop/manage/',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Portal error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
