const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const { invoiceEvent, subscriptionEvent, fakeStripe, secs, id } = require('../helpers/fixtures');
const { processEvent } = require('../../lib/stripeEvents');
const email = require('../../lib/email');
const settings = require('../../lib/settings');
const { setDelivered } = require('../../lib/sheet');
const edits = require('../../lib/orderEdits');
const { previews } = require('../../lib/emailTemplates');

// Capture everything that would go to Resend.
let sent = [];
const realFetch = globalThis.fetch;
function captureResend(fail = false) {
  sent = [];
  process.env.RESEND_API_KEY = 're_test';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      if (fail) return { ok: false, status: 500, json: async () => ({ message: 'down' }) };
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ id: `msg_${sent.length}` }) };
    }
    return realFetch(url, init);
  };
}
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.VERCEL_ENV; });

const stripe = fakeStripe();
const toCustomer = () => sent.filter((m) => m.to[0] !== 'info@justbread.shop');

test('templates: no em dashes anywhere, and every draft has a subject and body', () => {
  for (const p of previews()) {
    assert.ok(p.subject && p.text && p.html, p.name);
    assert.ok(!/—/.test(p.subject + p.text), `em dash in "${p.name}"`);
  }
});

test('customer emails are held until switched on; alerts to Jay are not', async () => {
  await freshDb(); captureResend(); process.env.VERCEL_ENV = 'production';
  const ev = invoiceEvent('invoice.paid', { invoiceId: 'in_new', created: '2030-11-04T15:00:00Z', billingReason: 'subscription_create' });
  const s = { ...stripe, subscriptions: { ...stripe.subscriptions, update: async () => ({}), retrieve: async () => ({ id: 'sub_A', status: 'active', latest_invoice: 'other', items: { data: [] }, metadata: {} }) } };
  await processEvent(ev, s);
  assert.equal(toCustomer().length, 0, 'held');
  const { rows } = await require('../../db/client').query(`SELECT status FROM emails_sent WHERE email_type='confirmation'`);
  assert.deepEqual(rows.map((r) => r.status), ['held']);
});

test('confirmation once for a new order, never for a renewal; previews never reach customers', async () => {
  await freshDb(); captureResend(); await settings.set('customer_emails_enabled', true);
  process.env.VERCEL_ENV = 'production';
  const s = { ...stripe, subscriptions: { ...stripe.subscriptions, update: async () => ({}), retrieve: async () => ({ id: 'sub_A', status: 'active', latest_invoice: 'other', items: { data: [] }, metadata: {} }) } };
  const first = invoiceEvent('invoice.paid', { invoiceId: 'in_1', created: '2030-11-04T15:00:00Z', billingReason: 'subscription_create' });
  await processEvent(first, s); await processEvent(first, s);
  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_2', created: '2030-11-11T12:00:00Z' }), s);
  assert.equal(toCustomer().length, 1);
  assert.equal(toCustomer()[0].to[0], 'a@example.com');
  assert.equal(toCustomer()[0].reply_to, 'info@justbread.shop');
  assert.match(toCustomer()[0].subject, /Your JustBread order/);

  // Same thing on a preview: redirected to info@ and marked TEST.
  await freshDb(); captureResend(); await settings.set('customer_emails_enabled', true);
  process.env.VERCEL_ENV = 'preview';
  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_3', created: '2030-11-04T15:00:00Z', billingReason: 'subscription_create' }), s);
  assert.equal(toCustomer().length, 0);
  const t = sent.find((m) => m.subject.startsWith('[TEST to a@example.com]'));
  assert.ok(t, 'redirected test copy');
  assert.equal(t.to[0], 'info@justbread.shop');
});

test('delivered: one email per order at the stop, once, with a working opt-out', async () => {
  const db = await freshDb(); captureResend(); await settings.set('customer_emails_enabled', true); process.env.VERCEL_ENV = 'production';
  const T = '2026-11-12';
  const house = JSON.stringify({ line1: '827 May St', postal_code: '60134' });
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_name, customer_email, loaves, fulfillment_type, delivery_method, shipping_address, fulfillment_date)
                  VALUES ('stripe','subscription','paid','Mike','mike@x.com',1,'local','local_delivery',$1,$2), ('stripe','onetime','paid','Sam','sam@x.com',2,'local','local_delivery',$1,$2)`, [house, T]);
  const { buildSheet } = require('../../lib/sheet');
  const key = (await buildSheet(T)).stops[0].stop_key;
  await setDelivered(T, key, true);
  await setDelivered(T, key, false);
  await setDelivered(T, key, true); // re-tick: no resend
  assert.deepEqual(toCustomer().map((m) => m.to[0]).sort(), ['mike@x.com', 'sam@x.com']);
  assert.match(toCustomer()[0].subject, /at your door/);
  assert.ok(toCustomer()[0].headers['List-Unsubscribe']);

  const link = await email.optOutLink('Mike@X.com');
  const u = new URL(link);
  assert.equal(await email.verifyOptOut(u.searchParams.get('e'), u.searchParams.get('s')), true);
  assert.equal(await email.verifyOptOut('sam@x.com', u.searchParams.get('s')), false, 'signature is per address');
  await email.setDeliveryEmails('mike@x.com', false);
  // next week: Mike opted out, Sam still gets it
  await db.query(`UPDATE orders SET fulfillment_date='2026-11-19'`);
  sent = [];
  await setDelivered('2026-11-19', key, true);
  assert.deepEqual(toCustomer().map((m) => m.to[0]), ['sam@x.com']);
});

test('subscription changes email the customer; the daily refresh does not', async () => {
  await freshDb(); captureResend(); await settings.set('customer_emails_enabled', true); process.env.VERCEL_ENV = 'production';
  await processEvent(subscriptionEvent('customer.subscription.updated', {
    created: '2026-11-05T12:00:00Z',
    sub: { pause_collection: { behavior: 'void', resumes_at: secs('2026-11-26T18:01:00Z') } },
    previous: { pause_collection: null },
  }), stripe);
  const m = toCustomer();
  assert.equal(m.length, 1);
  assert.match(m[0].text, /no bread and no charge until Thursday, December 3/);
  const { refreshAllSubscriptions } = require('../../lib/subscriptions');
  const live = subscriptionEvent('customer.subscription.updated', { created: '2026-11-06T00:00:00Z', sub: { status: 'canceled', cancellation_details: { reason: 'cancellation_requested' } } }).data.object;
  await refreshAllSubscriptions({ ...stripe, subscriptions: { list: async function* () { yield live; } } });
  assert.equal(toCustomer().length, 1, 'refresh sends nothing');
});

test('moving or cancelling one delivery emails the customer', async () => {
  await freshDb(); captureResend(); await settings.set('customer_emails_enabled', true); process.env.VERCEL_ENV = 'production';
  const o = await edits.createManual({ name: 'Kim Lee', email: 'kim@x.com', loaves: 1, delivery_method: 'pickup', pickup_location: 'Energy City Brewing — Batavia', thursday: '2026-11-12' });
  await edits.editOrder(o.id, { fulfillment_date: '2026-11-19' });
  await edits.editOrder(o.id, { note: 'side door' }); // not a move: no email
  await edits.cancelDelivery(o.id);
  assert.deepEqual(toCustomer().map((x) => x.subject), ['Your JustBread delivery moved', 'Your JustBread delivery is cancelled']);
  assert.match(toCustomer()[0].text, /moved from Thursday, November 12 to Thursday, November 19/);
});

test('alerts email Jay; a failed send is retried by the daily cron', async () => {
  await freshDb(); captureResend(true);
  await processEvent(invoiceEvent('invoice.payment_failed', { invoiceId: 'in_x', created: '2026-11-09T12:00:00Z' }), stripe);
  const { query } = require('../../db/client');
  assert.equal((await query(`SELECT status FROM emails_sent WHERE email_type='alert'`)).rows[0].status, 'failed');
  captureResend(false);
  const r = await email.retryFailed();
  assert.equal(r.sent, 1);
  assert.equal(sent[0].to[0], 'info@justbread.shop');
  assert.match(sent[0].subject, /Payment declined/);
});

test('push: dead devices are removed', async () => {
  const db = await freshDb();
  const push = require('../../lib/push');
  await push.subscribe({ endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' } }, 'phone');
  await push.subscribe({ endpoint: 'https://push/2', keys: { p256dh: 'a', auth: 'b' } }, 'old');
  const r = await push.pushAll({ body: 'hi' }, { send: async (sub) => { if (sub.endpoint.endsWith('/2')) { const e = new Error('gone'); e.statusCode = 410; throw e; } } });
  assert.deepEqual(r, { devices: 2, sent: 1 });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n, 1);
});

test('notice to all subscribers: approved by Jay, so it sends even while automatic emails are off', async () => {
  await freshDb(); captureResend(); process.env.VERCEL_ENV = 'production';
  for (const [sid, em] of [['sub_1', 'a@x.com'], ['sub_2', 'b@x.com'], ['sub_3', 'A@x.com']]) {
    await processEvent(subscriptionEvent('customer.subscription.updated', { created: '2026-11-01T00:00:00Z', sub: { id: sid } }), {
      ...stripe, customers: { retrieve: async () => ({ name: 'N', email: em }) },
    });
  }
  const { sendBroadcast } = require('../../lib/broadcast');
  const paused = [];
  const r = await sendBroadcast({ subject: 'Closed Thanksgiving week', body: 'No bread Nov 26.\n\nBack Dec 3.', pauseUntil: '2026-12-03' },
    { stripe: {}, skipUntil: async (_s, sid, until) => paused.push([sid, until]) });
  assert.equal(r.recipients, 2, 'same address twice counts once');
  assert.equal(r.sent, 2);
  assert.equal(paused.length, 2);
  assert.match(toCustomer()[0].text, /No bread Nov 26/);
});
