/**
 * Shared order-ingestion logic.
 *
 * Used by BOTH the live webhook (api/webhook.js) and the reconciliation
 * sweep (api/reconcile.js), so the two paths can never drift apart — a
 * "process*" function here does exactly what should happen when a given
 * Stripe event is seen, whether it arrived live or was found by re-walking
 * Stripe's Events API after the fact. Insertion is idempotent on
 * stripe_event_id, so calling a process* function twice for the same event
 * (once live, once during a reconciliation sweep) is safe — the second call
 * is a no-op.
 */

const { query } = require('../db/client');
const { LOCAL_DELIVERY_PRICE_IDS, LOAF_PRICE_IDS } = require('./prices');
const { lookupDeliveryCode } = require('./deliveryCodes');
const { computeFulfillmentDate } = require('./fulfillment');

// Classify a set of Stripe line items into { fulfillmentType, loaves }.
function classifyLineItems(lineItems) {
  let fulfillmentType = null;
  let loaves = 0;

  for (const item of lineItems) {
    const priceId = item.price?.id;
    const loavesPerUnit = priceId && LOAF_PRICE_IDS.get(priceId);
    if (loavesPerUnit) {
      loaves += loavesPerUnit * (item.quantity || 0);
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

// Distinguishes the three real-world delivery mechanics. A delivery-code
// order (RGD, ECB, etc.) is a fixed drop point, regardless of what
// fulfillmentType price-based logic said — the code always wins.
function classifyDelivery(metadata, fulfillmentType) {
  const match = metadata?.delivery_code && lookupDeliveryCode(metadata.delivery_code);
  if (match) {
    return { deliveryMethod: 'pickup', pickupLocation: match.label };
  }
  if (fulfillmentType === 'local') {
    return { deliveryMethod: 'local_delivery', pickupLocation: null };
  }
  return { deliveryMethod: 'shipped', pickupLocation: null };
}

// Address captured on a one-time Checkout Session. Prefers the shipping
// address (from shipping_address_collection) and falls back to the billing
// address on customer_details if shipping wasn't separately collected.
function extractSessionAddress(session) {
  const shipping = session.shipping_details;
  const customer = session.customer_details;
  const addr = shipping?.address || customer?.address || null;
  if (!addr) return null;
  return { name: shipping?.name || customer?.name || null, ...addr };
}

// Address for a subscription renewal. invoice.paid doesn't carry the
// shipping address itself, but Stripe copies what was collected at
// Checkout onto the Customer object, so it's available on every renewal —
// not just the first one.
async function extractCustomerAddress(stripe, customerId) {
  if (!customerId) return null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    const addr = customer.shipping?.address || customer.address || null;
    if (!addr) return null;
    return { name: customer.shipping?.name || customer.name || null, ...addr };
  } catch (err) {
    console.error('extractCustomerAddress failed:', err.message);
    return null;
  }
}

async function insertOrder({
  eventId, customerId, subscriptionId, email, name,
  loaves, fulfillmentType, orderType, cadence, rawMetadata,
  deliveryMethod, pickupLocation, shippingAddress, fulfillmentDate,
}) {
  const result = await query(
    `INSERT INTO orders (
       stripe_event_id, stripe_customer_id, stripe_subscription_id,
       customer_email, customer_name, loaves, fulfillment_type,
       order_type, cadence, raw_metadata,
       delivery_method, pickup_location, shipping_address, fulfillment_date
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING id`,
    [eventId, customerId, subscriptionId, email, name, loaves,
     fulfillmentType, orderType, cadence, JSON.stringify(rawMetadata || {}),
     deliveryMethod, pickupLocation,
     shippingAddress ? JSON.stringify(shippingAddress) : null,
     fulfillmentDate],
  );
  return { inserted: result.rowCount > 0 };
}

async function processCheckoutSessionCompleted(event, stripe) {
  const session = event.data.object;
  if (session.mode !== 'payment') {
    // Subscriptions are handled via invoice.paid instead — see webhook.js.
    return { inserted: false, skipped: 'subscription checkout' };
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    expand: ['data.price'],
  });
  const { fulfillmentType, loaves } = classifyLineItems(lineItems.data);
  const { deliveryMethod, pickupLocation } = classifyDelivery(session.metadata, fulfillmentType);
  const shippingAddress = deliveryMethod === 'pickup' ? null : extractSessionAddress(session);
  const fulfillmentDate = computeFulfillmentDate(new Date(session.created * 1000), deliveryMethod);

  return insertOrder({
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
    deliveryMethod,
    pickupLocation,
    shippingAddress,
    fulfillmentDate,
  });
}

async function processInvoicePaid(event, stripe) {
  const invoice = event.data.object;

  // Skip $0 invoices (e.g. proration credits) — not a real order.
  if (invoice.amount_paid === 0) {
    return { inserted: false, skipped: 'zero-amount invoice' };
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

  const { deliveryMethod, pickupLocation } = classifyDelivery(invoice.metadata, fulfillmentType);
  const shippingAddress = deliveryMethod === 'pickup'
    ? null
    : await extractCustomerAddress(stripe, invoice.customer);
  const fulfillmentDate = computeFulfillmentDate(new Date(invoice.created * 1000), deliveryMethod);

  return insertOrder({
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
    deliveryMethod,
    pickupLocation,
    shippingAddress,
    fulfillmentDate,
  });
}

module.exports = {
  classifyLineItems,
  classifyDelivery,
  extractSessionAddress,
  extractCustomerAddress,
  insertOrder,
  processCheckoutSessionCompleted,
  processInvoicePaid,
};
