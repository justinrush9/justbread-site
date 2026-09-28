/**
 * JustBread — Stripe Webhook
 * ==========================
 * POST /api/webhook
 *
 * This is the fix for "I sometimes miss an order": every paid order,
 * one-time or subscription, lands here the instant Stripe confirms payment
 * and gets written to Postgres as a row in `orders` — including which
 * delivery mechanic it is (pickup point / local delivery / shipped), the
 * delivery address where one applies, and which bake week it's assigned to
 * (see lib/fulfillment.js for the cutoff rule).
 *
 * The actual event handling lives in lib/orderProcessing.js, shared with
 * api/reconcile.js — this file is just signature verification + dispatch.
 *
 * Listens for:
 *   - checkout.session.completed (mode=payment)  -> one-time orders
 *   - invoice.paid                                -> every subscription
 *                                                     charge, including the
 *                                                     very first one
 *
 * checkout.session.completed for mode=subscription is intentionally
 * ignored — invoice.paid fires for that same initial charge too
 * (billing_reason=subscription_create), so handling both would double
 * every new subscriber's first order.
 *
 * Environment variables (set in Vercel dashboard):
 *   STRIPE_SECRET_KEY       same key checkout.js and portal.js use
 *   STRIPE_WEBHOOK_SECRET   whsec_... from the Stripe webhook endpoint config
 *   DATABASE_URL            Postgres connection string
 *
 * Setup:
 *   1. Deploy this file.
 *   2. In Stripe Dashboard -> Developers -> Webhooks, add an endpoint
 *      pointing at https://www.justbread.shop/api/webhook (the "www." form
 *      — see CLAUDE.md gotcha re: apex redirect), listening for
 *      checkout.session.completed and invoice.paid.
 *   3. Copy the signing secret it gives you into STRIPE_WEBHOOK_SECRET.
 *
 * If a delivery is ever missed anyway (signature mismatch, cold-start
 * timeout, endpoint briefly down), /api/reconcile re-walks Stripe's own
 * event history and catches it — don't hand-fix a missing row here.
 */

const Stripe = require('stripe');
const { processCheckoutSessionCompleted, processInvoicePaid } = require('../lib/orderProcessing');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vercel: turn off automatic body parsing so we can read the raw bytes —
// Stripe's signature check fails against a re-serialized JSON body.
module.exports.config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await processCheckoutSessionCompleted(event, stripe);
    }

    if (event.type === 'invoice.paid') {
      await processInvoicePaid(event, stripe);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    // Return 500 so Stripe retries — we want a transient DB hiccup to
    // resolve itself rather than silently lose an order.
    return res.status(500).json({ error: 'Internal error processing webhook' });
  }
};
