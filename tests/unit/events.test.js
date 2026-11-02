const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const { invoiceEvent, subscriptionEvent, fakeStripe, secs, id } = require('../helpers/fixtures');
const { processEvent } = require('../../lib/stripeEvents');
const { PRICES } = require('../../lib/prices');

const stripe = fakeStripe();
const orders = (db) => db.query('SELECT * FROM orders ORDER BY id').then((r) => r.rows);
const alerts = (db) => db.query('SELECT * FROM alerts ORDER BY id').then((r) => r.rows);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

test('one-time order: inserted once, replay is a no-op', async () => {
  const db = await freshDb();
  const ev = {
    id: id('evt'), type: 'checkout.session.completed', created: secs('2026-11-09T15:00:00Z'),
    data: { object: {
      id: 'cs_1', mode: 'payment', payment_status: 'paid', customer: 'cus_B', payment_intent: 'pi_cs1',
      created: secs('2026-11-09T15:00:00Z'), amount_total: 1700, metadata: {},
      customer_details: { email: 'b@example.com', name: 'Bo', address: { postal_code: '60134' } },
    } },
  };
  const s = fakeStripe({ lineItems: [
    { price: { id: PRICES.loaf.onetime }, quantity: 1 },
    { price: { id: PRICES.localOnetime }, quantity: 1 },
  ] });
  await processEvent(ev, s);
  await processEvent(ev, s);
  const rows = await orders(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delivery_method, 'local_delivery');
  assert.equal(day(rows[0].fulfillment_date), '2026-11-12');
  assert.equal(rows[0].payment_status, 'paid');
});

test('declined then retry succeeds: one row flips to paid, one alert', async () => {
  const db = await freshDb();
  const created = '2026-11-09T12:00:00Z'; // Monday 6 AM Central renewal
  await processEvent(invoiceEvent('invoice.payment_failed', { invoiceId: 'in_1', created }), stripe);
  await processEvent(invoiceEvent('invoice.payment_failed', { invoiceId: 'in_1', created }), stripe); // Stripe retry fails again
  let rows = await orders(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_status, 'declined');
  assert.equal(day(rows[0].fulfillment_date), '2026-11-12');
  assert.equal((await alerts(db)).length, 1, 'retries must not add alerts');

  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_1', created, eventCreated: secs('2026-11-10T12:00:00Z') }), stripe);
  rows = await orders(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_status, 'paid');
  assert.equal(day(rows[0].fulfillment_date), '2026-11-12', 'fulfillment_date never recalculated');
});

test('out of order: a late decline never turns a paid row back to declined', async () => {
  const db = await freshDb();
  const created = '2026-11-09T12:00:00Z';
  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_2', created }), stripe);
  await processEvent(invoiceEvent('invoice.payment_failed', { invoiceId: 'in_2', created }), stripe);
  const rows = await orders(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_status, 'paid');
  assert.equal((await alerts(db)).length, 0);
});

test('placement: renewal vs first payment', async () => {
  const db = await freshDb();
  // Wednesday 10 AM Central
  const wed = '2026-11-11T16:00:00Z';
  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_renew', created: wed, billingReason: 'subscription_cycle' }), stripe);
  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_first', created: wed, billingReason: 'subscription_create', sub: 'sub_B' }), stripe);
  const rows = await orders(db);
  const by = Object.fromEntries(rows.map((r) => [r.stripe_invoice_id, day(r.fulfillment_date)]));
  assert.equal(by.in_renew, '2026-11-12', 'renewal charged Wed -> that Thursday');
  assert.equal(by.in_first, '2026-11-19', 'new signup Wed -> past Tuesday cutoff -> next Thursday');
});

test('zero-amount invoices are not orders', async () => {
  const db = await freshDb();
  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_0', created: '2026-11-09T12:00:00Z', amount: 0 }), stripe);
  assert.equal((await orders(db)).length, 0);
});

test('refunds: partial keeps the order, full removes it, replays and late paid events change nothing', async () => {
  const db = await freshDb();
  const created = '2026-11-09T12:00:00Z';
  const paid = invoiceEvent('invoice.paid', { invoiceId: 'in_3', created });
  await processEvent(paid, stripe);
  const refund = (amt, full) => ({
    id: id('evt'), type: 'charge.refunded', created: secs('2026-11-10T00:00:00Z'),
    data: { object: { id: 'ch_3', amount: 1500, amount_refunded: amt, refunded: full, payment_intent: 'pi_in_3', invoice: 'in_3' } },
  });
  await processEvent(refund(500, false), stripe);
  let [row] = await orders(db);
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.refunded_cents, 500);

  const fullEv = refund(1500, true);
  await processEvent(fullEv, stripe);
  await processEvent(fullEv, stripe);
  await processEvent(refund(500, false), stripe); // stale partial replayed later
  await processEvent(paid, stripe);               // stale paid replayed later
  [row] = await orders(db);
  assert.equal(row.payment_status, 'refunded');
  assert.equal(row.refunded_cents, 1500);
  assert.deepEqual((await alerts(db)).map((a) => a.type), ['refund_partial', 'refund_full', 'refund_partial']);
});

test('subscription mirror: cancel scheduled, undone, stale events ignored, no duplicate alerts', async () => {
  const db = await freshDb();
  await processEvent(subscriptionEvent('customer.subscription.created', { created: '2026-11-02T12:00:00Z' }), stripe);
  const cancel = subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-03T12:00:00Z',
    sub: { cancel_at_period_end: true, cancellation_details: { feedback: 'too_expensive' } },
    previous: { cancel_at_period_end: false },
  });
  await processEvent(cancel, stripe);
  await processEvent(cancel, stripe);
  let sub = (await db.query('SELECT * FROM subscriptions')).rows[0];
  assert.equal(sub.cancel_at_period_end, true);
  assert.equal(sub.loaves, 1);
  assert.equal(sub.cadence, 'weekly');
  assert.equal(sub.delivery_method, 'local_delivery');

  // An older event replayed after the newer one must not roll state back.
  await processEvent(subscriptionEvent('customer.subscription.updated', { created: '2026-11-02T13:00:00Z' }), stripe);
  sub = (await db.query('SELECT * FROM subscriptions')).rows[0];
  assert.equal(sub.cancel_at_period_end, true);

  await processEvent(subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-04T12:00:00Z', previous: { cancel_at_period_end: true },
  }), stripe);
  const types = (await alerts(db)).map((a) => a.type);
  assert.deepEqual(types, ['cancellation_scheduled', 'cancellation_undone']);
  assert.match((await alerts(db))[0].message, /Reason: too_expensive/);
});

test('subscription ended after failed payments', async () => {
  const db = await freshDb();
  await processEvent(subscriptionEvent('customer.subscription.deleted', {
    created: '2026-11-14T12:00:00Z',
    sub: { status: 'canceled', ended_at: secs('2026-11-14T12:00:00Z'), cancellation_details: { reason: 'payment_failed' } },
  }), stripe);
  const sub = (await db.query('SELECT * FROM subscriptions')).rows[0];
  assert.equal(sub.status, 'canceled');
  assert.equal(sub.ended_reason, 'failed_payment');
  assert.equal(sub.next_renewal_at, null);
  const [a] = await alerts(db);
  assert.equal(a.type, 'subscription_ended');
  assert.match(a.message, /after failed payment/);
});

test('pause and resume raise alerts', async () => {
  const db = await freshDb();
  await processEvent(subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-05T12:00:00Z',
    sub: { pause_collection: { behavior: 'void', resumes_at: secs('2026-11-24T12:00:00Z') } },
    previous: { pause_collection: null },
  }), stripe);
  await processEvent(subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-25T12:00:00Z', previous: { pause_collection: { behavior: 'void' } },
  }), stripe);
  assert.deepEqual((await alerts(db)).map((a) => a.type), ['paused', 'resumed']);
});

test('daily refresh fills the mirror without alerts, and a later stale event is ignored', async () => {
  const db = await freshDb();
  const { refreshAllSubscriptions } = require('../../lib/subscriptions');
  const live = subscriptionEvent('customer.subscription.updated', { created: '2026-11-02T00:00:00Z' }).data.object;
  const ended = { ...live, id: 'sub_Z', status: 'canceled', ended_at: secs('2026-10-01T00:00:00Z'), cancellation_details: { reason: 'cancellation_requested' } };
  const s = { ...stripe, subscriptions: { ...stripe.subscriptions, list: async function* () { yield live; yield ended; } } };
  const now = secs('2026-11-09T13:00:00Z');
  const r = await refreshAllSubscriptions(s, now);
  assert.equal(r.refreshed, 2);
  const subs = (await db.query('SELECT * FROM subscriptions ORDER BY stripe_subscription_id')).rows;
  assert.deepEqual(subs.map((x) => [x.stripe_subscription_id, x.status, x.ended_reason]), [['sub_A', 'active', null], ['sub_Z', 'canceled', 'customer']]);
  assert.equal((await alerts(db)).length, 0);
  await processEvent(subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-05T00:00:00Z', sub: { cancel_at_period_end: true }, previous: { cancel_at_period_end: false },
  }), stripe);
  assert.equal((await db.query("SELECT cancel_at_period_end FROM subscriptions WHERE stripe_subscription_id='sub_A'")).rows[0].cancel_at_period_end, false);
});
