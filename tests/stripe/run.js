// Stripe test-mode scenarios (SPEC.md core rule 10: 4a and 6d test-clock
// cases). Runs on GitHub's servers (see .github/workflows/ci.yml). Prints a
// JSON report to stdout. Test mode only: refuses anything but an sk_test_ key.
//
// Every scenario uses the app's own code (lib/billingAnchor.js,
// lib/subscriptionControls.js, lib/moveToMonday.js) against real Stripe test
// clocks, then checks which Thursdays actually got charged.

const key = process.env.STRIPE_TEST_KEY || '';
if (!key.startsWith('sk_test_')) {
  console.log(JSON.stringify({ ok: false, error: 'STRIPE_TEST_KEY missing or not a test key' }));
  process.exit(0);
}
const stripe = require('stripe')(key);
const { anchorFirstRenewal } = require('../../lib/billingAnchor');
const { skipThisWeek, skipUntil, resume } = require('../../lib/subscriptionControls');
const { planOne, apply } = require('../../lib/moveToMonday');
const {
  computeFulfillmentDate, computeRenewalFulfillmentDate, chicagoTimeToEpoch, chicagoParts, shiftDate,
} = require('../../lib/fulfillment');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECURRING = {
  weekly: { interval: 'week', interval_count: 1 },
  biweekly: { interval: 'week', interval_count: 2 },
  monthly: { interval: 'month', interval_count: 1 },
};

// Base Monday: at least 7 days out, so every clock starts in the future.
function baseMonday() {
  const p = chicagoParts(new Date(Date.now() + 8 * 86400e3));
  const dow = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday];
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return shiftDate(date, 7 - dow);
}
const B = baseMonday();
const at = (dayOffset, h, m = 0) => chicagoTimeToEpoch(shiftDate(B, dayOffset), h, m);
const thu = (dayOffset) => shiftDate(B, dayOffset);

async function waitReady(clockId) {
  for (let i = 0; i < 120; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === 'ready') return c;
    if (c.status === 'internal_failure') throw new Error(`clock ${clockId} failed`);
    await sleep(2000);
  }
  throw new Error(`clock ${clockId} never became ready`);
}

// Advance in steps of at most 6 days (Stripe limits how far a clock can jump
// relative to the shortest subscription interval).
async function advanceTo(clock, target) {
  let now = clock.frozen_time;
  while (now < target) {
    now = Math.min(target, now + 6 * 86400);
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: now });
    clock = await waitReady(clock.id);
  }
  return clock;
}

let product;
async function setup(name, startEpoch) {
  const clock = await waitReady((await stripe.testHelpers.testClocks.create({ frozen_time: startEpoch, name })).id);
  const customer = await stripe.customers.create({
    test_clock: clock.id, name, email: `${name}@example.com`,
    payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' },
  });
  return { clock, customer };
}

async function createSub(customer, cadence) {
  return stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price_data: { currency: 'usd', product: product.id, unit_amount: 1500, recurring: RECURRING[cadence] } }],
    expand: ['latest_invoice'],
  });
}

// Every invoice on the subscription, and the Thursday each paid one covers.
async function charged(subId, { allRenewalRule = false } = {}) {
  const invoices = [];
  for await (const inv of stripe.invoices.list({ subscription: subId, limit: 100 })) invoices.push(inv);
  invoices.sort((a, b) => a.created - b.created);
  const fmt = (s) => {
    const p = chicagoParts(new Date(s * 1000));
    return `${p.weekday} ${p.month}/${p.day} ${p.hour}:${String(p.minute).padStart(2, '0')}`;
  };
  const rows = invoices.map((i) => ({
    created: fmt(i.created), reason: i.billing_reason, status: i.status, paid: i.amount_paid,
    thursday: i.status === 'paid' && i.amount_paid > 0
      ? (i.billing_reason === 'subscription_create' && !allRenewalRule
        ? computeFulfillmentDate(new Date(i.created * 1000), 'local_delivery')
        : computeRenewalFulfillmentDate(new Date(i.created * 1000)))
      : null,
    monday6: (() => { const p = chicagoParts(new Date(i.created * 1000)); return p.weekday === 'Mon' && p.hour === 6; })(),
  }));
  const paidThursdays = rows.filter((r) => r.thursday).map((r) => r.thursday);
  return { rows, paidThursdays };
}

function check(name, got, want, extra = []) {
  const problems = [...extra];
  const dupes = got.filter((t, i) => got.indexOf(t) !== i);
  if (dupes.length) problems.push(`charged twice for ${dupes.join(', ')}`);
  if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`charged Thursdays ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  return { name, ok: problems.length === 0, problems };
}

// 4a: new signups, first renewal moved to the Monday of the next delivery week.
function signupScenario(name, cadence, startEpoch, horizonDays, expectThursdays) {
  return async () => {
    const { clock, customer } = await setup(name, startEpoch);
    try {
      const sub = await createSub(customer, cadence);
      const first = sub.latest_invoice;
      const anchor = await anchorFirstRenewal(stripe, first, cadence, clock.frozen_time);
      const after = await stripe.subscriptions.retrieve(sub.id);
      await advanceTo(clock, at(horizonDays, 9));
      const { rows, paidThursdays } = await charged(sub.id);
      const extra = [];
      if (!anchor.anchored) extra.push(`not anchored: ${anchor.reason}`);
      if (after.status !== 'trialing') extra.push(`status after anchor ${after.status}`);
      rows.filter((r) => r.reason !== 'subscription_create' && r.paid > 0 && !r.monday6)
        .forEach((r) => extra.push(`renewal not Monday 6 AM: ${r.created}`));
      rows.filter((r) => r.paid > 0 && r.paid !== 1500).forEach((r) => extra.push(`charged ${r.paid} at ${r.created}`));
      return { ...check(name, paidThursdays, expectThursdays, extra), invoices: rows };
    } finally {
      await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
    }
  };
}

// 6d: skips and resume on an anchored weekly subscription (signup Mon B 9 AM).
function controlScenario(name, steps, horizonDays, expectThursdays, cadence = 'weekly', start = at(0, 9)) {
  return async () => {
    let { clock, customer } = await setup(name, start);
    try {
      const sub = await createSub(customer, cadence);
      if (cadence !== 'monthly') await anchorFirstRenewal(stripe, sub.latest_invoice, cadence, clock.frozen_time);
      const log = [];
      for (const [whenEpoch, fn] of steps) {
        clock = await advanceTo(clock, whenEpoch);
        log.push(await fn(sub.id, clock.frozen_time));
      }
      await advanceTo(clock, at(horizonDays, 9));
      const { rows, paidThursdays } = await charged(sub.id);
      return { ...check(name, paidThursdays, expectThursdays), log, invoices: rows };
    } finally {
      await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
    }
  };
}

// 4a: an existing Wednesday-renewing weekly subscription moved to Monday.
function moveScenario() {
  const name = 'move_wed_to_mon';
  return async () => {
    let { clock, customer } = await setup(name, at(2, 11)); // Wed B+2 11 AM: stands in for an old Wednesday renewal
    try {
      const sub = await createSub(customer, 'weekly');
      clock = await advanceTo(clock, at(5, 10)); // Saturday: preview and apply
      const preview = planOne(await stripe.subscriptions.retrieve(sub.id), clock.frozen_time);
      const applied = await apply(stripe, [sub.id], clock.frozen_time);
      await advanceTo(clock, at(20, 9));
      const { rows, paidThursdays } = await charged(sub.id, { allRenewalRule: true });
      const extra = preview.action === 'ready' ? [] : [`preview said ${preview.action}: ${preview.why}`];
      return { ...check(name, paidThursdays, [thu(3), thu(10), thu(17)], extra), preview, applied, invoices: rows };
    } finally {
      await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
    }
  };
}

const scenarios = {
  // Weekly signups. First delivery by the Tuesday cutoff; renewals Mondays after.
  weekly_mon_9am: signupScenario('weekly_mon_9am', 'weekly', at(0, 9), 20, [thu(3), thu(10), thu(17)]),
  weekly_tue_1159: signupScenario('weekly_tue_1159', 'weekly', at(1, 11, 59), 20, [thu(3), thu(10), thu(17)]),
  weekly_tue_1201: signupScenario('weekly_tue_1201', 'weekly', at(1, 12, 1), 20, [thu(10), thu(17)]),
  weekly_sat: signupScenario('weekly_sat', 'weekly', at(5, 10), 20, [thu(10), thu(17)]),
  // Every-other-week signups.
  biweekly_mon_9am: signupScenario('biweekly_mon_9am', 'biweekly', at(0, 9), 34, [thu(3), thu(17), thu(31)]),
  biweekly_tue_1159: signupScenario('biweekly_tue_1159', 'biweekly', at(1, 11, 59), 34, [thu(3), thu(17), thu(31)]),
  biweekly_tue_1201: signupScenario('biweekly_tue_1201', 'biweekly', at(1, 12, 1), 34, [thu(10), thu(24)]),
  biweekly_sat: signupScenario('biweekly_sat', 'biweekly', at(5, 10), 34, [thu(10), thu(24)]),

  // Skip one week: renewals Mon B+7 (pays B+10) and B+14 (pays B+17). Skip
  // B+17 after B+7 has charged; B+21 charges normally.
  skip_one_week: controlScenario('skip_one_week', [
    [at(8, 9), (id, now) => skipThisWeek(stripe, id, thu(17), now)],
  ], 27, [thu(3), thu(10), thu(24)]),
  // Skip until: on Tue B+1, skip until back on B+24. B+7 and B+14 renewals void.
  skip_until_3_weeks: controlScenario('skip_until_3_weeks', [
    [at(1, 9), (id, now) => skipUntil(stripe, id, thu(24), now)],
  ], 27, [thu(3), thu(24)]),
  // Resume early: skip until B+31, then resume on Tue B+8 (B+7 already voided).
  resume_early: controlScenario('resume_early', [
    [at(1, 9), (id, now) => skipUntil(stripe, id, thu(31), now)],
    [at(8, 9), (id) => resume(stripe, id)],
  ], 20, [thu(3), thu(17)]),
  // Monthly: signup Wed B+2 (first delivery B+10 by cutoff); skip the next
  // month's renewal, the month after charges.
  monthly_skip: (() => {
    const name = 'monthly_skip';
    return async () => {
      let { clock, customer } = await setup(name, at(2, 10));
      try {
        const sub = await createSub(customer, 'monthly');
        const nextRenewal = (await stripe.subscriptions.retrieve(sub.id)).current_period_end;
        const skipThu = computeRenewalFulfillmentDate(new Date(nextRenewal * 1000));
        clock = await advanceTo(clock, at(9, 9));
        const skipped = await skipThisWeek(stripe, sub.id, skipThu, clock.frozen_time);
        await advanceTo(clock, nextRenewal + 40 * 86400);
        const { rows, paidThursdays } = await charged(sub.id);
        const thirdThu = computeRenewalFulfillmentDate(new Date((await stripe.subscriptions.retrieve(sub.id)).current_period_start * 1000));
        return { ...check(name, paidThursdays, [thu(10), thirdThu], skipThu === thirdThu ? ['skipped Thursday was charged'] : []), skipped, invoices: rows };
      } finally {
        await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
      }
    };
  })(),

  move_wed_to_mon: moveScenario(),
};

(async () => {
  const report = { ok: false, base_monday: B, results: [] };
  try {
    product = await stripe.products.create({ name: 'CI test loaf' });
    const only = process.env.SCENARIOS ? process.env.SCENARIOS.split(',') : Object.keys(scenarios);
    const settled = await Promise.allSettled(only.map((n) => scenarios[n]()));
    report.results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { name: only[i], ok: false, problems: [String(s.reason?.message || s.reason)] }));
    report.ok = report.results.every((r) => r.ok);
    await stripe.products.update(product.id, { active: false }).catch(() => {});
  } catch (e) {
    report.error = e.message;
  }
  console.log(JSON.stringify(report, null, 2));
})();
