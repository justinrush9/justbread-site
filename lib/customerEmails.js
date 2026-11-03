/**
 * When customer emails go out (SPEC.md 9d). Every call goes through
 * lib/email.js, which dedupes, holds them until Jay switches them on, and
 * redirects them outside production. None of these throw.
 */

const { query } = require('../db/client');
const { sendEmail, optOutLink } = require('./email');
const tpl = require('./emailTemplates');
const { asDateStr } = require('./dates');

const safe = (fn) => async (...args) => {
  try { return await fn(...args); } catch (err) { console.error('customer email error:', err.message); return { status: 'error' }; }
};

/** A new order was paid: one-time, or a subscription's first payment. Never renewals. */
const onOrderPaid = safe(async (orderId) => {
  const { rows: [o] } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o || !o.customer_email || o.payment_status !== 'paid') return { status: 'skipped' };
  if (o.order_type === 'subscription' && o.billing_reason !== 'subscription_create') return { status: 'skipped', reason: 'renewal' };
  return sendEmail({
    type: 'confirmation', dedupeKey: `confirmation:order:${o.id}`, to: o.customer_email, customer: true, orderId: o.id,
    ...tpl.confirmation({ ...o, fulfillment_date: asDateStr(o.fulfillment_date) }),
  });
});

/** Jay ticked a stop Delivered: one email per order with an address at that stop. */
const onStopDelivered = safe(async (thursday, stopKey) => {
  const { buildSheet } = require('./sheet');
  const sheet = await buildSheet(thursday);
  const out = [];
  for (const e of sheet.entries.filter((x) => x.stop_key === stopKey && x.kind === 'order' && x.customer_email && !x.skipped)) {
    const shippedStop = stopKey === 'shipping';
    const link = await optOutLink(e.customer_email);
    const t = shippedStop ? tpl.shipped(e, link) : tpl.delivered(e, link);
    out.push(await sendEmail({
      type: shippedStop ? 'shipped' : 'delivered', dedupeKey: `${shippedStop ? 'shipped' : 'delivered'}:order:${e.id}:${thursday}`,
      to: e.customer_email, customer: true, orderId: e.id, ...t,
    }));
  }
  return out;
});

const thursdayOf = (secs) => {
  if (!secs) return null;
  const { computeRenewalFulfillmentDate } = require('./fulfillment');
  return computeRenewalFulfillmentDate(new Date(secs * 1000));
};

/** A subscription changed (from the app's skip buttons or the customer portal). */
const onSubscriptionChange = safe(async (event, sub, contact, alertTypes) => {
  if (!contact?.email) return { status: 'skipped' };
  const name = contact.name;
  const send = (kind, data) => sendEmail({
    type: 'change', dedupeKey: `change:${event.id}:${kind}`, to: contact.email, customer: true, subscriptionId: sub.id,
    ...tpl.change(kind, { name, ...data }),
  });
  const out = [];
  for (const t of alertTypes) {
    if (t === 'paused') {
      const r = sub.pause_collection?.resumes_at;
      out.push(await send('skipped', { until: r ? thursdayOf(r) : null }));
    } else if (t === 'resumed') out.push(await send('resumed', { next: thursdayOf(sub.current_period_end) }));
    else if (t === 'cancellation_scheduled') {
      // Last delivery: the Thursday the current (already paid) period covers.
      out.push(await send('cancellation_scheduled', { last: thursdayOf(sub.current_period_start) }));
    } else if (t === 'cancellation_undone') out.push(await send('cancellation_undone', {}));
    else if (t === 'subscription_ended') out.push(await send('ended', { failedPayment: sub.cancellation_details?.reason === 'payment_failed' }));
  }
  return out;
});

/** Jay moved or cancelled one delivery (6c). */
const onOrderChanged = safe(async (order, kind, data) => {
  if (!order?.customer_email) return { status: 'skipped' };
  const n = Array.isArray(order.history) ? order.history.length : 0;
  return sendEmail({
    type: 'change', dedupeKey: `change:order:${order.id}:${n}`, to: order.customer_email, customer: true, orderId: order.id,
    ...tpl.change(kind, { name: order.customer_name, loaves: order.loaves, ...data }),
  });
});

module.exports = { onOrderPaid, onStopDelivered, onSubscriptionChange, onOrderChanged };
