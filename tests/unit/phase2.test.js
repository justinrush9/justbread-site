const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const { subscriptionEvent, invoiceEvent, fakeStripe, secs } = require('../helpers/fixtures');
const { processEvent } = require('../../lib/stripeEvents');
const { expectedFor } = require('../../lib/expected');
const { skipThisWeek, skipUntil, resume, ControlError } = require('../../lib/subscriptionControls');

const stripe = fakeStripe();

test('expected renewals: monthly renewal on Wednesday shows on that Thursday, then becomes the order', async () => {
  const db = await freshDb();
  await processEvent(subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-01T00:00:00Z', sub: { current_period_end: secs('2026-11-11T16:00:00Z') }, // Wed 10 AM CT
  }), stripe);
  let e = await expectedFor('2026-11-12');
  assert.equal(e.length, 1);
  assert.equal(e[0].skipped, false);
  assert.equal((await expectedFor('2026-11-19')).length, 0);

  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_w', created: '2026-11-11T16:00:00Z' }), stripe);
  e = await expectedFor('2026-11-12');
  assert.equal(e.length, 0, 'paid renewal replaces the expected entry');
  const o = (await db.query("SELECT fulfillment_date::text AS d FROM orders")).rows[0];
  assert.equal(o.d, '2026-11-12');
});

test('expected renewals: skipped, cancelled, and Thursday-afternoon cases', async () => {
  await freshDb();
  const mk = (id, sub) => processEvent(subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-01T00:00:00Z', sub: { id, ...sub },
  }), stripe);
  await mk('sub_skip', { current_period_end: secs('2026-11-09T12:00:00Z'), pause_collection: { behavior: 'void', resumes_at: secs('2026-11-12T18:01:00Z') } });
  await mk('sub_cancel', { current_period_end: secs('2026-11-09T12:00:00Z'), cancel_at_period_end: true });
  await mk('sub_thu_pm', { current_period_end: secs('2026-11-12T19:00:00Z') }); // Thu 1 PM CT -> next week
  const thisWeek = await expectedFor('2026-11-12');
  assert.deepEqual(thisWeek.map((x) => [x.stripe_subscription_id, x.skipped]), [['sub_skip', true]]);
  const nextWeek = await expectedFor('2026-11-19');
  assert.deepEqual(nextWeek.map((x) => x.stripe_subscription_id), ['sub_thu_pm']);
});

function controlStripe(sub) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      retrieve: async () => sub,
      update: async (id, p) => { calls.push(p); return {}; },
    },
  };
}

test('skip this week pauses until Thursday 12:01 PM; refuses an already-paid or later Thursday', async () => {
  const now = secs('2026-11-05T12:00:00Z');
  const s = controlStripe({ id: 'sub_A', status: 'active', current_period_end: secs('2026-11-09T12:00:00Z') });
  await skipThisWeek(s, 'sub_A', '2026-11-12', now);
  assert.equal(s.calls[0].pause_collection.behavior, 'void');
  assert.equal(new Date(s.calls[0].pause_collection.resumes_at * 1000).toISOString(), '2026-11-12T18:01:00.000Z');
  await assert.rejects(skipThisWeek(s, 'sub_A', '2026-11-05', now), /already paid/);
  await assert.rejects(skipThisWeek(s, 'sub_A', '2026-11-19', now), /Skip until/);
  await assert.rejects(skipThisWeek(s, 'sub_A', '2026-11-13', now), /not a Thursday/);
});

test('skip until: pause ends after the prior Thursday noon so that Thursday renewals charge', async () => {
  const s = controlStripe({ id: 'sub_A', status: 'active', current_period_end: secs('2026-11-09T12:00:00Z') });
  await skipUntil(s, 'sub_A', '2026-12-03', secs('2026-11-05T12:00:00Z'));
  assert.equal(new Date(s.calls[0].pause_collection.resumes_at * 1000).toISOString(), '2026-11-26T18:01:00.000Z');
});

test('resume clears the pause; cancelled subscriptions cannot be skipped', async () => {
  const s = controlStripe({ id: 'sub_A', status: 'active', pause_collection: { behavior: 'void' } });
  assert.deepEqual(await resume(s, 'sub_A'), { resumed: true });
  assert.equal(s.calls[0].pause_collection, '');
  const dead = controlStripe({ id: 'sub_B', status: 'canceled' });
  await assert.rejects(skipUntil(dead, 'sub_B', '2026-12-03'), ControlError);
});

test('move to Monday: Wednesday renewal moves to Monday of the same week; monthly and paused untouched', () => {
  const { planOne } = require('../../lib/moveToMonday');
  const weekly = { interval: 'week', interval_count: 1 };
  const now = secs('2026-11-14T12:00:00Z'); // Saturday
  const wed = secs('2026-11-18T17:00:00Z');  // Wed Nov 18, 11 AM CT
  const w = planOne({ id: 'a', status: 'active', current_period_end: wed, items: { data: [{ price: { recurring: weekly } }] } }, now);
  assert.equal(w.action, 'ready');
  assert.equal(new Date(w.target * 1000).toISOString(), '2026-11-16T12:00:00.000Z'); // Mon Nov 16 6 AM CT
  assert.equal(w.pays_for_thursday, '2026-11-19');
  const late = planOne({ id: 'b', status: 'active', current_period_end: wed, items: { data: [{ price: { recurring: weekly } }] } }, secs('2026-11-17T12:00:00Z'));
  assert.equal(late.action, 'wait');
  const monthly = planOne({ id: 'c', status: 'active', current_period_end: wed, items: { data: [{ price: { recurring: { interval: 'month', interval_count: 1 } } }] } }, now);
  assert.equal(monthly.action, 'skip');
  const paused = planOne({ id: 'd', status: 'active', pause_collection: { behavior: 'void' }, current_period_end: wed, items: { data: [{ price: { recurring: weekly } }] } }, now);
  assert.equal(paused.action, 'skip');
});
