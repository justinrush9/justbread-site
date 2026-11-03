/**
 * Subscriptions mirror (SPEC.md section 12) plus the subscription alerts in 9c.
 *
 * Fed by customer.subscription.created / .updated / .deleted. Each event
 * carries the full subscription, so the row is simply overwritten with it,
 * but only if the event is at least as new as the last one applied: the
 * reconcile can replay older events after newer ones.
 */

const { query } = require('../db/client');
const { addAlert } = require('./alerts');
const {
  classifyLineItems, classifyDelivery, cadenceFromRecurring, extractCustomerAddress,
} = require('./orderProcessing');

const ts = (secs) => (secs ? new Date(secs * 1000).toISOString() : null);

function fmtDate(secs) {
  return new Date(secs * 1000).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric',
  });
}

function planLabel(cadence, loaves) {
  const c = { weekly: 'weekly', biweekly: 'every other week', monthly: 'monthly' }[cadence] || 'subscription';
  return `${loaves || '?'} loaf${loaves === 1 ? '' : 'ves'} ${c}`;
}

function endedReason(sub) {
  const r = sub.cancellation_details?.reason;
  if (r === 'payment_failed') return 'failed_payment';
  if (r === 'cancellation_requested') return 'customer';
  return r ? 'customer' : null;
}

function customerComment(sub) {
  const d = sub.cancellation_details || {};
  return [d.feedback, d.comment].filter(Boolean).join(': ') || null;
}

async function customerContact(stripe, customerId) {
  if (!customerId) return {};
  try {
    const c = await stripe.customers.retrieve(customerId);
    if (c.deleted) return {};
    return { name: c.name || c.shipping?.name || null, email: c.email || null, phone: c.phone || null };
  } catch (err) {
    console.error('customerContact failed:', err.message);
    return {};
  }
}

// Alerts worth raising for this change (9c). `prev` is Stripe's
// previous_attributes: only the fields that changed in this event.
function alertsFor(event, sub, who, plan) {
  const prev = event.data.previous_attributes || {};
  const out = [];
  if (event.type === 'customer.subscription.deleted') {
    const how = { failed_payment: 'after failed payment', customer: 'cancelled' }[endedReason(sub)] || 'ended';
    out.push({ type: 'subscription_ended', message: `Subscription ended (${how}): ${who}, ${plan}. Removed from future sheets.` });
    return out;
  }
  if (event.type !== 'customer.subscription.updated') return out;

  if ('cancel_at_period_end' in prev || 'cancel_at' in prev) {
    const nowCancelling = sub.cancel_at_period_end || !!sub.cancel_at;
    const wasCancelling = 'cancel_at_period_end' in prev ? prev.cancel_at_period_end : !!prev.cancel_at;
    if (nowCancelling && !wasCancelling) {
      const endsAt = sub.cancel_at || sub.current_period_end;
      const comment = customerComment(sub);
      out.push({
        type: 'cancellation_scheduled',
        message: `Cancellation scheduled: ${who}, ${plan}. Ends ${fmtDate(endsAt)}.${comment ? ` Reason: ${comment}.` : ''}`,
      });
    } else if (!nowCancelling && wasCancelling) {
      out.push({ type: 'cancellation_undone', message: `Staying: ${who} undid their cancellation (${plan}).` });
    }
  }
  if ('pause_collection' in prev) {
    if (sub.pause_collection && !prev.pause_collection) {
      const until = sub.pause_collection.resumes_at ? ` until ${fmtDate(sub.pause_collection.resumes_at)}` : '';
      out.push({ type: 'paused', message: `Paused: ${who}, ${plan}${until}.` });
    } else if (!sub.pause_collection && prev.pause_collection) {
      out.push({ type: 'resumed', message: `Resumed: ${who}, ${plan}.` });
    }
  }
  return out;
}

async function processSubscriptionEvent(event, stripe) {
  const sub = event.data.object;
  const items = sub.items?.data || [];
  const { fulfillmentType, loaves } = classifyLineItems(items);
  const cadence = cadenceFromRecurring(items.find((i) => i.price?.recurring)?.price?.recurring);
  const { deliveryMethod, pickupLocation } = classifyDelivery(sub.metadata, fulfillmentType);
  const contact = await customerContact(stripe, sub.customer);
  const address = deliveryMethod === 'pickup' ? null : await extractCustomerAddress(stripe, sub.customer);
  const deleted = event.type === 'customer.subscription.deleted';

  const result = await query(
    `INSERT INTO subscriptions (
       stripe_subscription_id, stripe_customer_id, customer_name, customer_email, customer_phone,
       cadence, loaves, delivery_method, pickup_location, shipping_address,
       status, next_renewal_at, pause_resumes_at, paused, cancel_at_period_end, cancel_at,
       ended_at, ended_reason, cancellation_comment, stripe_event_created, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       customer_name = EXCLUDED.customer_name, customer_email = EXCLUDED.customer_email,
       customer_phone = EXCLUDED.customer_phone, cadence = EXCLUDED.cadence, loaves = EXCLUDED.loaves,
       delivery_method = EXCLUDED.delivery_method, pickup_location = EXCLUDED.pickup_location,
       shipping_address = EXCLUDED.shipping_address, status = EXCLUDED.status,
       next_renewal_at = EXCLUDED.next_renewal_at, pause_resumes_at = EXCLUDED.pause_resumes_at,
       paused = EXCLUDED.paused, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       cancel_at = EXCLUDED.cancel_at, ended_at = EXCLUDED.ended_at,
       ended_reason = EXCLUDED.ended_reason, cancellation_comment = EXCLUDED.cancellation_comment,
       stripe_event_created = EXCLUDED.stripe_event_created, updated_at = now()
     WHERE subscriptions.stripe_event_created <= EXCLUDED.stripe_event_created
     RETURNING stripe_subscription_id`,
    [sub.id, sub.customer, contact.name || null, contact.email || null, contact.phone || null,
     cadence, loaves || null, deliveryMethod, pickupLocation,
     address ? JSON.stringify(address) : null,
     deleted ? 'canceled' : sub.status,
     deleted ? null : ts(sub.current_period_end),
     ts(sub.pause_collection?.resumes_at), !!sub.pause_collection,
     !!sub.cancel_at_period_end, ts(sub.cancel_at),
     deleted ? ts(sub.ended_at || event.created) : ts(sub.ended_at),
     deleted ? endedReason(sub) : null,
     customerComment(sub),
     event.created],
  );
  const applied = result.rowCount > 0;

  // Alerts are keyed by event id, so they're safe to raise even on a replay;
  // a stale event (not applied) raises nothing.
  const synthetic = String(event.id).startsWith('refresh:');
  if (applied && !synthetic) {
    const who = contact.name || contact.email || sub.customer;
    const found = alertsFor(event, sub, who, planLabel(cadence, loaves));
    for (const a of found) {
      await addAlert({ eventId: `${event.id}:${a.type}`, type: a.type, subscriptionId: sub.id, message: a.message });
    }
    if (found.length) await require('./customerEmails').onSubscriptionChange(event, sub, contact, found.map((a) => a.type));
  }
  return { applied };
}

// Daily full refresh (SPEC.md section 3 cron): re-reads every subscription
// from Stripe so the mirror (above all next_renewal_at) is right even if an
// event was missed entirely. Applied as a synthetic event stamped "now", with
// no previous_attributes, so it never raises alerts.
async function refreshAllSubscriptions(stripe, nowSecs = Math.floor(Date.now() / 1000)) {
  const summary = { refreshed: 0, errors: [] };
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    const type = sub.status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated';
    try {
      await processSubscriptionEvent({ id: `refresh:${sub.id}:${nowSecs}`, type, created: nowSecs, data: { object: sub } }, stripe);
      summary.refreshed += 1;
    } catch (err) {
      summary.errors.push({ subscription: sub.id, message: err.message });
    }
  }
  return summary;
}

module.exports = { processSubscriptionEvent, refreshAllSubscriptions, alertsFor, endedReason };
