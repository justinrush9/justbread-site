/**
 * Skip / skip until / resume (SPEC.md 6d). These and billingAnchor.js are
 * the only places the app writes to an existing subscription (core rule 9):
 * they set or clear pause_collection and nothing else.
 *
 * How the dates work: a renewal that charges after Thursday 12:00 PM Central
 * belongs to the *next* Thursday (core rule 5). So "no delivery on Thursday T"
 * means "no charge before T's noon", and the pause ends at T 12:01 PM.
 * "Back on Thursday T" means renewals for T must charge again, i.e. the pause
 * ends right after the previous Thursday's noon.
 */

const { computeRenewalFulfillmentDate, chicagoTimeToEpoch, shiftDate } = require('./fulfillment');

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

class ControlError extends Error {}

function isThursday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 4;
}

async function loadActive(stripe, subscriptionId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  if (!ACTIVE.has(sub.status)) throw new ControlError(`Subscription is ${sub.status}; nothing to skip.`);
  return sub;
}

/**
 * Skip the next delivery only. `thursday` must be the Thursday the next
 * renewal pays for; that renewal must not have charged yet.
 */
async function skipThisWeek(stripe, subscriptionId, thursday, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!isThursday(thursday)) throw new ControlError(`${thursday} is not a Thursday.`);
  const sub = await loadActive(stripe, subscriptionId);
  const next = sub.current_period_end;
  const nextThursday = computeRenewalFulfillmentDate(new Date(next * 1000));
  if (nextThursday !== thursday) {
    // The Thursday asked for is already paid (its renewal has charged) or is
    // further out than the next renewal.
    throw new ControlError(
      next <= nowSecs || thursday < nextThursday
        ? `Thursday ${thursday} is already paid. Cancel that delivery and refund in Stripe instead.`
        : `The next renewal pays for Thursday ${nextThursday}. Use "Skip until" to skip further out.`,
    );
  }
  const resumesAt = chicagoTimeToEpoch(thursday, 12, 1);
  await stripe.subscriptions.update(subscriptionId, { pause_collection: { behavior: 'void', resumes_at: resumesAt } });
  return { skipped: [thursday], resumesAt };
}

/** No charges or deliveries until `backOn` (the first Thursday they get bread again). */
async function skipUntil(stripe, subscriptionId, backOn, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!isThursday(backOn)) throw new ControlError(`${backOn} is not a Thursday.`);
  await loadActive(stripe, subscriptionId);
  const resumesAt = chicagoTimeToEpoch(shiftDate(backOn, -7), 12, 1);
  if (resumesAt <= nowSecs) throw new ControlError(`Back on ${backOn} is too soon to skip anything.`);
  await stripe.subscriptions.update(subscriptionId, { pause_collection: { behavior: 'void', resumes_at: resumesAt } });
  return { resumesAt };
}

/** End a skip or pause now. */
async function resume(stripe, subscriptionId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  if (!sub.pause_collection) return { resumed: false, reason: 'not paused' };
  // An empty string clears pause_collection in the Stripe API.
  await stripe.subscriptions.update(subscriptionId, { pause_collection: '' });
  return { resumed: true };
}

module.exports = { skipThisWeek, skipUntil, resume, ControlError };
