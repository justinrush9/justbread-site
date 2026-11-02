/**
 * Expected renewals (SPEC.md 4c). For a given Thursday: every subscription
 * whose next renewal (from the subscriptions mirror) lands on that Thursday
 * under core rule 5 and hasn't produced an order for it yet.
 *
 * Subscriptions whose renewal is inside a skip/pause come back as
 * `skipped: true` (shown greyed, not counted). A scheduled cancellation that
 * takes effect before the renewal means no renewal, so no entry.
 */

const { query } = require('../db/client');
const { computeRenewalFulfillmentDate } = require('./fulfillment');

const toIso = (v) => (v instanceof Date ? v.toISOString() : v);

async function expectedFor(thursday) {
  const { rows } = await query(
    `SELECT s.* FROM subscriptions s
     WHERE s.status IN ('active', 'trialing', 'past_due')
       AND s.next_renewal_at IS NOT NULL
       AND s.next_renewal_at BETWEEN ($1::date - INTERVAL '8 days') AND ($1::date + INTERVAL '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.stripe_subscription_id = s.stripe_subscription_id AND o.fulfillment_date = $1::date)`,
    [thursday],
  );
  const out = [];
  for (const s of rows) {
    const renewal = new Date(toIso(s.next_renewal_at));
    if (computeRenewalFulfillmentDate(renewal) !== thursday) continue;
    if (s.cancel_at_period_end) continue;
    if (s.cancel_at && new Date(toIso(s.cancel_at)) <= renewal) continue;
    const skipped = s.paused && (!s.pause_resumes_at || new Date(toIso(s.pause_resumes_at)) > renewal);
    out.push({
      stripe_subscription_id: s.stripe_subscription_id,
      customer_name: s.customer_name,
      customer_email: s.customer_email,
      customer_phone: s.customer_phone,
      loaves: s.loaves,
      cadence: s.cadence,
      delivery_method: s.delivery_method,
      pickup_location: s.pickup_location,
      shipping_address: s.shipping_address,
      charges_at: renewal.toISOString(),
      skipped: !!skipped,
    });
  }
  return out;
}

module.exports = { expectedFor };
