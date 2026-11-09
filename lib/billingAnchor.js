/**
 * Monday renewals (SPEC.md section 4a, core rules 6 and 9).
 *
 * New weekly and every-other-week subscriptions: Checkout charges the first
 * delivery in full. When that first payment arrives, the next charge is moved
 * to 6:00 AM Central on the Monday of the *next* delivery week, using
 * `trial_end` with no proration. "Trial" is only Stripe's name for "don't
 * bill again until this date"; nobody gets anything free.
 *
 * Monthly subscriptions are never moved (section 4b).
 */

const { computeFulfillmentDate, chicagoTimeToEpoch, shiftDate } = require('./fulfillment');

const RENEWAL_HOUR = 6; // 6:00 AM Central

const WEEKS = { weekly: 1, biweekly: 2 };

// The Monday 6 AM Central that should be the first renewal, for a first
// payment made at `paidAt` delivering by the Tuesday-noon cutoff. Pass
// `firstThursday` when the first delivery's week is already known (a week
// with a moved-earlier cutoff, SPEC 7f, can push it a week later).
function firstRenewalEpoch(paidAt, cadence, firstThursday) {
  const weeks = WEEKS[cadence];
  if (!weeks) return null;
  firstThursday = firstThursday || computeFulfillmentDate(paidAt, 'local_delivery');
  const mondayOfFirstWeek = shiftDate(firstThursday, -3);
  return chicagoTimeToEpoch(shiftDate(mondayOfFirstWeek, 7 * weeks), RENEWAL_HOUR);
}

/**
 * Called on invoice.paid with billing_reason = subscription_create.
 * Safe to call repeatedly (webhook retries, reconcile replays): it only acts
 * while this invoice is still the subscription's latest and the target is
 * in the future, and it does nothing if the renewal is already there.
 */
async function anchorFirstRenewal(stripe, invoice, cadence, nowSecs = Math.floor(Date.now() / 1000), firstThursday = null) {
  if (invoice.billing_reason !== 'subscription_create') return { anchored: false, reason: 'not a first payment' };
  const target = firstRenewalEpoch(new Date(invoice.created * 1000), cadence, firstThursday);
  if (!target) return { anchored: false, reason: `cadence ${cadence} is not moved` };
  if (target <= nowSecs) return { anchored: false, reason: 'target already passed' };

  const sub = await stripe.subscriptions.retrieve(invoice.subscription);
  const latest = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
  if (latest !== invoice.id) return { anchored: false, reason: 'subscription has billed since' };
  if (sub.current_period_end === target || sub.trial_end === target) return { anchored: false, reason: 'already anchored', target };
  if (!['active', 'trialing'].includes(sub.status)) return { anchored: false, reason: `status ${sub.status}` };

  await stripe.subscriptions.update(sub.id, { trial_end: target, proration_behavior: 'none' });
  return { anchored: true, target };
}

module.exports = { firstRenewalEpoch, anchorFirstRenewal, RENEWAL_HOUR };
