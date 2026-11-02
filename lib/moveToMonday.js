/**
 * One-time switch of existing weekly / every-other-week subscriptions to
 * Monday renewals (SPEC.md 4a, existing subscriptions, steps 2 and 3).
 *
 * Each subscription's next renewal moves from its current day to 6:00 AM
 * Central on the Monday of that same week, with trial_end and no proration.
 * Today's subscriptions renew Wednesday: the Wednesday charge paid for the
 * next day's Thursday, and the moved Monday charge pays for that same
 * week's Thursday, so no Thursday is charged twice or skipped.
 *
 * plan() only reads. apply() changes only the subscriptions Jay listed, and
 * only ones plan() still marks ready.
 */

const { chicagoParts, chicagoTimeToEpoch, computeRenewalFulfillmentDate, shiftDate } = require('./fulfillment');
const { cadenceFromRecurring } = require('./orderProcessing');

const ACTIVE = new Set(['active', 'trialing', 'past_due']);
const fmt = (s) => new Date(s * 1000).toLocaleString('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function mondayOfWeek(epoch) {
  const p = chicagoParts(new Date(epoch * 1000));
  const dow = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday];
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return shiftDate(date, -dow);
}

function planOne(sub, nowSecs) {
  const recurring = sub.items?.data?.find((i) => i.price?.recurring)?.price?.recurring;
  const cadence = cadenceFromRecurring(recurring);
  const row = {
    id: sub.id, customer: sub.customer, status: sub.status, cadence,
    current_renewal: sub.current_period_end ? fmt(sub.current_period_end) : null,
  };
  if (!ACTIVE.has(sub.status)) return { ...row, action: 'skip', why: `status ${sub.status}` };
  if (sub.pause_collection) return { ...row, action: 'skip', why: 'paused; move after it resumes' };
  if (!['weekly', 'biweekly'].includes(cadence)) return { ...row, action: 'skip', why: 'monthly stays on its date' };

  const current = sub.current_period_end;
  const target = chicagoTimeToEpoch(mondayOfWeek(current), 6);
  const paysFor = computeRenewalFulfillmentDate(new Date(target * 1000));
  if (target === current) return { ...row, action: 'skip', why: 'already Monday 6 AM' };
  if (target <= nowSecs + 3600) {
    return { ...row, action: 'wait', why: `that Monday has passed; run again after ${fmt(current)}` };
  }
  return { ...row, action: 'ready', target, new_renewal: fmt(target), pays_for_thursday: paysFor };
}

async function plan(stripe, nowSecs = Math.floor(Date.now() / 1000)) {
  const rows = [];
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') continue;
    rows.push(planOne(sub, nowSecs));
  }
  return rows;
}

async function apply(stripe, ids, nowSecs = Math.floor(Date.now() / 1000)) {
  const wanted = new Set(ids);
  const results = [];
  for (const id of wanted) {
    const sub = await stripe.subscriptions.retrieve(id);
    const row = planOne(sub, nowSecs);
    if (row.action !== 'ready') { results.push({ id, changed: false, why: row.why }); continue; }
    await stripe.subscriptions.update(id, { trial_end: row.target, proration_behavior: 'none' });
    results.push({ id, changed: true, new_renewal: row.new_renewal, pays_for_thursday: row.pays_for_thursday });
  }
  return results;
}

module.exports = { plan, apply, planOne, mondayOfWeek };
