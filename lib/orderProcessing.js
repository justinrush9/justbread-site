/**
 * Order ingestion from Stripe (SPEC.md section 5).
 *
 * Used by BOTH the live webhook (api/webhook.js) and the reconcile sweep
 * (api/reconcile.js) through lib/stripeEvents.js, so the two paths can never
 * drift apart. Every function here is safe to call twice for the same event,
 * and safe when events arrive out of order:
 *   - one-time orders are unique on stripe_event_id;
 *   - subscription orders are unique on stripe_invoice_id, whether the
 *     invoice first arrives as failed or as paid;
 *   - a paid row never goes back to declined, a refunded row never goes back
 *     to paid;
 *   - fulfillment_date is set when the row is created and never changed.
 */

const { query } = require('../db/client');
const { LOCAL_DELIVERY_PRICE_IDS, LOAF_PRICE_IDS } = require('./prices');
const { lookupDeliveryCode } = require('./deliveryCodes');
const { computeFulfillmentDate, computeRenewalFulfillmentDate } = require('./fulfillment');
const { addAlert } = require('./alerts');

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

  // No local-delivery price line -> IL shipping (an inline price_data line,
  // so it never matches a stored price ID) or a loaf-only invoice.
  if (!fulfillmentType) fulfillmentType = 'shipped';

  return { fulfillmentType, loaves };
}

// A delivery-code order (RGD, ECB, etc.) is a fixed pickup point, whatever
// the price-based classification said: the code always wins.
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

function extractSessionAddress(session) {
  const shipping = session.shipping_details;
  const customer = session.customer_details;
  const addr = shipping?.address || customer?.address || null;
  if (!addr) return null;
  return { name: shipping?.name || customer?.name || null, ...addr };
}

// invoice.* events don't carry the delivery address; Stripe copies what was
// collected at Checkout onto the Customer, so it's there on every renewal.
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

function cadenceFromRecurring(recurring) {
  if (!recurring) return null;
  if (recurring.interval === 'week' && recurring.interval_count === 1) return 'weekly';
  if (recurring.interval === 'week' && recurring.interval_count === 2) return 'biweekly';
  if (recurring.interval === 'month' && recurring.interval_count === 1) return 'monthly';
  return null;
}

// Which Thursday an invoice delivers on. Renewals are placed by core rule 5
// (charge by Thursday noon -> that Thursday); everything else is a new
// payment and uses the Tuesday-noon cutoff (core rule 4).
function placeInvoice(invoice, deliveryMethod) {
  const at = new Date(invoice.created * 1000);
  if (invoice.billing_reason === 'subscription_cycle') {
    return computeRenewalFulfillmentDate(at);
  }
  return computeFulfillmentDate(at, deliveryMethod);
}

function formatThursday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}

function dollars(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── One-time orders ───────────────────────────────────────────────────────

async function processCheckoutSessionCompleted(event, stripe) {
  const session = event.data.object;
  if (session.mode !== 'payment') {
    // Subscriptions are handled through invoice.* events instead; their
    // first payment fires invoice.paid (billing_reason = subscription_create).
    return { inserted: false, skipped: 'subscription checkout' };
  }
  if (session.payment_status && session.payment_status !== 'paid') {
    return { inserted: false, skipped: `payment_status ${session.payment_status}` };
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    expand: ['data.price'],
  });
  const { fulfillmentType, loaves } = classifyLineItems(lineItems.data);
  const { deliveryMethod, pickupLocation } = classifyDelivery(session.metadata, fulfillmentType);
  const shippingAddress = deliveryMethod === 'pickup' ? null : extractSessionAddress(session);
  const fulfillmentDate = computeFulfillmentDate(new Date(session.created * 1000), deliveryMethod);

  const result = await query(
    `INSERT INTO orders (
       source, stripe_event_id, stripe_customer_id, stripe_subscription_id,
       stripe_payment_intent_id, customer_email, customer_name, customer_phone,
       loaves, fulfillment_type, order_type, cadence, raw_metadata,
       delivery_method, pickup_location, shipping_address, fulfillment_date,
       payment_status, amount_cents
     ) VALUES ('stripe',$1,$2,NULL,$3,$4,$5,$6,$7,$8,'onetime',NULL,$9,$10,$11,$12,$13,'paid',$14)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING id`,
    [event.id, session.customer, session.payment_intent || null,
     session.customer_details?.email || null, session.customer_details?.name || null,
     session.customer_details?.phone || null,
     loaves, fulfillmentType, JSON.stringify(session.metadata || {}),
     deliveryMethod, pickupLocation,
     shippingAddress ? JSON.stringify(shippingAddress) : null,
     fulfillmentDate, session.amount_total ?? null],
  );
  const inserted = result.rowCount > 0;
  if (inserted) await require('./customerEmails').onOrderPaid(result.rows[0].id);
  return { inserted };
}

// ── Subscription orders (paid and declined) ──────────────────────────────

async function upsertInvoiceOrder(event, stripe, newStatus) {
  const invoice = event.data.object;
  const amount = newStatus === 'paid' ? invoice.amount_paid : invoice.amount_due;

  // $0 invoices (proration credits, a $0 trial start) aren't deliveries.
  if (!amount) return { inserted: false, skipped: 'zero-amount invoice' };
  if (!invoice.subscription) return { inserted: false, skipped: 'not a subscription invoice' };

  const { fulfillmentType, loaves } = classifyLineItems(invoice.lines?.data || []);
  if (!loaves) return { inserted: false, skipped: 'no loaves on invoice' };

  let cadence = cadenceFromRecurring(
    (invoice.lines?.data || []).find((l) => l.price?.recurring)?.price?.recurring,
  );
  let metadata = invoice.subscription_details?.metadata || invoice.metadata || {};
  if (!cadence || !Object.keys(metadata).length) {
    const sub = await stripe.subscriptions.retrieve(invoice.subscription);
    cadence = cadence || cadenceFromRecurring(sub.items?.data?.[0]?.price?.recurring);
    if (!Object.keys(metadata).length) metadata = sub.metadata || {};
  }

  const { deliveryMethod, pickupLocation } = classifyDelivery(metadata, fulfillmentType);
  const shippingAddress = deliveryMethod === 'pickup'
    ? null
    : await extractCustomerAddress(stripe, invoice.customer);
  const fulfillmentDate = placeInvoice(invoice, deliveryMethod);

  // Insert, or apply the one allowed transition (declined -> paid). Anything
  // else on an existing row is a replay and changes nothing.
  const result = await query(
    `INSERT INTO orders (
       source, stripe_event_id, stripe_customer_id, stripe_subscription_id,
       stripe_invoice_id, stripe_payment_intent_id, billing_reason,
       customer_email, customer_name, customer_phone,
       loaves, fulfillment_type, order_type, cadence, raw_metadata,
       delivery_method, pickup_location, shipping_address, fulfillment_date,
       payment_status, amount_cents
     ) VALUES ('stripe',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'subscription',$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL DO UPDATE SET
       payment_status = CASE
         WHEN orders.payment_status = 'declined' AND EXCLUDED.payment_status = 'paid' THEN 'paid'
         ELSE orders.payment_status END,
       amount_cents = CASE
         WHEN orders.payment_status = 'declined' AND EXCLUDED.payment_status = 'paid' THEN EXCLUDED.amount_cents
         ELSE orders.amount_cents END,
       stripe_payment_intent_id = COALESCE(orders.stripe_payment_intent_id, EXCLUDED.stripe_payment_intent_id)
     RETURNING id, payment_status, fulfillment_date, (xmax = 0) AS inserted`,
    [event.id, invoice.customer, invoice.subscription, invoice.id,
     invoice.payment_intent || null, invoice.billing_reason || null,
     invoice.customer_email || null, invoice.customer_name || null, invoice.customer_phone || null,
     loaves, fulfillmentType, cadence, JSON.stringify(metadata),
     deliveryMethod, pickupLocation,
     shippingAddress ? JSON.stringify(shippingAddress) : null,
     fulfillmentDate, newStatus, amount],
  );
  const row = result.rows[0];
  const inserted = row.inserted === true || row.inserted === 't';

  // Alert on a decline only the first time this invoice is seen as declined,
  // so Stripe's retries don't produce an alert each.
  if (newStatus === 'declined' && inserted) {
    const thursday = typeof row.fulfillment_date === 'string'
      ? row.fulfillment_date.slice(0, 10)
      : row.fulfillment_date.toISOString().slice(0, 10);
    await addAlert({
      eventId: event.id,
      type: 'payment_declined',
      subscriptionId: invoice.subscription,
      message: `Payment declined: ${invoice.customer_name || invoice.customer_email || invoice.customer}, `
        + `${dollars(amount)}, for Thursday ${formatThursday(thursday)}.`,
    });
  }

  if (row.payment_status === 'paid') await require('./customerEmails').onOrderPaid(row.id);
  return { inserted, status: row.payment_status };
}

async function processInvoicePaid(event, stripe) {
  const result = await upsertInvoiceOrder(event, stripe, 'paid');
  const invoice = event.data.object;
  if (invoice.billing_reason === 'subscription_create' && invoice.subscription) {
    // Lazy require: billingAnchor -> fulfillment only, but keep load order simple.
    const { anchorFirstRenewal } = require('./billingAnchor');
    const recurring = (invoice.lines?.data || []).find((l) => l.price?.recurring)?.price?.recurring;
    result.anchor = await anchorFirstRenewal(stripe, invoice, cadenceFromRecurring(recurring));
  }
  return result;
}

function processInvoicePaymentFailed(event, stripe) {
  return upsertInvoiceOrder(event, stripe, 'declined');
}

// ── Refunds ───────────────────────────────────────────────────────────────

async function processChargeRefunded(event) {
  const charge = event.data.object;
  const refunded = charge.amount_refunded || 0;
  const full = charge.refunded === true || refunded >= charge.amount;

  const keys = [charge.payment_intent, charge.invoice].filter(Boolean);
  if (!keys.length) return { updated: false, skipped: 'charge has no payment intent or invoice' };

  // refunded_cents is set to Stripe's running total (never added to), so a
  // replay is harmless. A full refund marks the order refunded for good.
  const result = await query(
    `UPDATE orders SET
       refunded_cents = GREATEST(refunded_cents, $1),
       payment_status = CASE WHEN $2 THEN 'refunded' ELSE payment_status END
     WHERE stripe_payment_intent_id = ANY($3) OR stripe_invoice_id = ANY($3)
     RETURNING id, customer_name, customer_email, fulfillment_date`,
    [refunded, full, keys],
  );
  if (!result.rowCount) return { updated: false, skipped: 'no matching order' };

  const row = result.rows[0];
  const thursday = row.fulfillment_date
    ? (typeof row.fulfillment_date === 'string'
      ? row.fulfillment_date.slice(0, 10)
      : row.fulfillment_date.toISOString().slice(0, 10))
    : null;
  await addAlert({
    eventId: event.id,
    type: full ? 'refund_full' : 'refund_partial',
    subscriptionId: null,
    message: `${full ? 'Refunded' : 'Partly refunded'}: ${row.customer_name || row.customer_email || 'customer'}, `
      + `${dollars(refunded)}${thursday ? `, Thursday ${formatThursday(thursday)}` : ''}.`,
  });
  return { updated: true, full };
}

module.exports = {
  classifyLineItems,
  classifyDelivery,
  cadenceFromRecurring,
  extractSessionAddress,
  extractCustomerAddress,
  placeInvoice,
  formatThursday,
  processCheckoutSessionCompleted,
  processInvoicePaid,
  processInvoicePaymentFailed,
  processChargeRefunded,
};
