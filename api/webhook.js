/**
 * JustBread — Stripe Webhook
 * ==========================
 * POST /api/webhook
 *
 * This is the fix for "I sometimes miss an order": every paid order,
 * one-time or subscription, lands here the instant Stripe confirms payment
 * and gets written to Postgres as a row in `orders`. No more relying on
 * noticing a payment in the Stripe dashboard.
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
 *      pointing at https://justbread.shop/api/webhook, listening for
 *      checkout.session.completed and invoice.paid.
 *   3. Copy the signing secret it gives you into STRIPE_WEBHOOK_SECRET.
 */

const Stripe = require('stripe');
const { query } = require('../db/client');
const { LOCAL_DELIVERY_PRICE_IDS, LOAF_PRICE_IDS } = require('../lib/prices');

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

// Classify a set of Stripe line items into { fulfillmentType, loaves }.
function classifyLineItems(lineItems) {
  let fulfillmentType = null;
  let loaves = 0;

  for (const item of lineItems) {
    const priceId = item.price?.id;
    if (priceId && LOAF_PRICE_IDS.has(priceId)) {
      loaves += item.quantity || 0;
    }
    if (priceId && LOCAL_DELIVERY_PRICE_IDS.has(priceId)) {
      fulfillmentType = 'local';
    }
  }

  // No matching local-delivery price line -> it's either IL shipping
  // (an inline price_data line, so it never matches a stored price ID)
  // or a loaf-only invoice. Either way, default to 'shipped'.
  if (!fulfillmentType) fulfillmentType = 'shipped';

  return { fulfillmentType, loaves };
}

async function insertOrder({
  eventId, customerId, subscriptionId, email, name,
  loaves, fulfillmentType, orderType, cadence, rawMetadata,
}) {
  await query(
    `INSERT INTO orders (
       stripe_event_id, stripe_customer_id, stripe_subscription_id,
       customer_email, customer_name, loaves, fulfillment_type,
       order_type, cadence, raw_metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [eventId, customerId, subscriptionId, email, name, loaves,
     fulfillmentType, orderType, cadence, JSON.stringify(rawMetadata || {})],
  );
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
      const session = event.data.object;
      if (session.mode !== 'payment') {
        // Subscriptions are handled via invoice.paid instead — see comment above.
        return res.status(200).json({ received: true, skipped: 'subscription checkout' });
      }

      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price'],
      });
      const { fulfillmentType, loaves } = classifyLineItems(lineItems.data);

      await insertOrder({
        eventId: event.id,
        customerId: session.customer,
        subscriptionId: null,
        email: session.customer_details?.email,
        name: session.customer_details?.name,
        loaves,
        fulfillmentType,
        orderType: 'onetime',
        cadence: null,
        rawMetadata: session.metadata,
      });
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;

      // Skip $0 invoices (e.g. proration credits) — not a real order.
      if (invoice.amount_paid === 0) {
        return res.status(200).json({ received: true, skipped: 'zero-amount invoice' });
      }

      const { fulfillmentType, loaves } = classifyLineItems(invoice.lines.data);

      let cadence = null;
      if (invoice.subscription) {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const interval = sub.items.data[0]?.price?.recurring?.interval;
        const intervalCount = sub.items.data[0]?.price?.recurring?.interval_count;
        if (interval === 'week' && intervalCount === 1) cadence = 'weekly';
        else if (interval === 'week' && intervalCount === 2) cadence = 'biweekly';
        else if (interval === 'month') cadence = 'monthly';
      }

      await insertOrder({
        eventId: event.id,
        customerId: invoice.customer,
        subscriptionId: invoice.subscription,
        email: invoice.customer_email,
        name: invoice.customer_name,
        loaves,
        fulfillmentType,
        orderType: 'subscription',
        cadence,
        rawMetadata: invoice.metadata,
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    // Return 500 so Stripe retries — we want a transient DB hiccup to
    // resolve itself rather than silently lose an order.
    return res.status(500).json({ error: 'Internal error processing webhook' });
  }
};
