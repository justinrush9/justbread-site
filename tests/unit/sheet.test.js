const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const { subscriptionEvent, fakeStripe, secs } = require('../helpers/fixtures');
const { processEvent } = require('../../lib/stripeEvents');
const { buildSheet, setDelivered, setExtrasOverride, extrasFor, normalizeAddress } = require('../../lib/sheet');
const so = require('../../lib/standingOrders');
const edits = require('../../lib/orderEdits');

const T = '2026-11-12';
const ins = (db, f) => db.query(
  `INSERT INTO orders (source, order_type, payment_status, customer_name, loaves, fulfillment_type, delivery_method, pickup_location, shipping_address, fulfillment_date)
   VALUES ('stripe', $1, $2, $3, $4, 'local', $5, $6, $7, $8) RETURNING id`,
  [f.type || 'onetime', f.status || 'paid', f.name, f.loaves, f.method, f.pickup || null, f.addr ? JSON.stringify(f.addr) : null, f.date || T],
);

test('baker\'s dozen extras', () => {
  assert.equal(extrasFor(11), 0);
  assert.equal(extrasFor(12), 1);
  assert.equal(extrasFor(25), 2);
  assert.equal(extrasFor(25, 0), 0);
});

test('address normalization merges the same house', () => {
  assert.equal(normalizeAddress({ line1: '827 May Street', postal_code: '60134' }), normalizeAddress({ line1: '827 may st.', postal_code: '60134-1234' }));
});

test('sheet summary, stops, and delivered per stop', async () => {
  const db = await freshDb();
  const house = { line1: '827 May St', city: 'Geneva', state: 'IL', postal_code: '60134' };
  await ins(db, { name: 'Mike', loaves: 1, method: 'local_delivery', addr: house, type: 'subscription' });
  await ins(db, { name: 'Mike spouse', loaves: 2, method: 'local_delivery', addr: { ...house, line1: '827 May Street' } });
  await ins(db, { name: 'Cam', loaves: 1, method: 'local_delivery', addr: { line1: '825 May St', postal_code: '60134' }, status: 'declined', type: 'subscription' });
  await ins(db, { name: 'Pick1', loaves: 2, method: 'pickup', pickup: 'Energy City Brewing — Batavia' });
  await ins(db, { name: 'Ship1', loaves: 3, method: 'shipped', addr: { line1: '1 A St', postal_code: '60513' } });
  await ins(db, { name: 'Ship2', loaves: 1, method: 'shipped', addr: { line1: '2 B St', postal_code: '60185' } });
  const { rows: [refunded] } = await ins(db, { name: 'Gone', loaves: 5, method: 'shipped', addr: { line1: '3 C', postal_code: '60000' } });
  await db.query(`UPDATE orders SET payment_status='refunded' WHERE id=$1`, [refunded.id]);
  const { rows: [cancelled] } = await ins(db, { name: 'Cancelled', loaves: 4, method: 'pickup', pickup: 'CM Florals — St. Charles' });
  await edits.cancelDelivery(cancelled.id);
  await so.create({ name: 'Coffee Shop', loaves: 2, delivery_method: 'pickup', pickup_location: 'Energy City Brewing — Batavia', frequency: 'weekly', start_date: '2026-11-05' });
  await processEvent(subscriptionEvent('customer.subscription.updated', { created: '2026-11-01T00:00:00Z', sub: { id: 'sub_X', current_period_end: secs('2026-11-11T16:00:00Z') } }), fakeStripe());

  let sheet = await buildSheet(T);
  const s = sheet.summary;
  // ordered: 1+2+1 (local) + 2 (pickup) + 4 (shipped) + 2 (barter) + 1 (expected, at the fake customer's house) = 13
  assert.equal(s.ordered, 13);
  assert.equal(s.extras, 1);
  assert.equal(s.to_bake, 14);
  assert.equal(s.expected_loaves, 1);
  assert.equal(s.pickup_loaves, 4);
  assert.equal(s.shipped_loaves, 4);
  assert.equal(s.declined, 1);
  assert.equal(s.manual_or_standing, 1);
  // stops: 827 May (2 orders), 825 May, 1 Main St (expected sub), Energy City, shipping = 5
  assert.equal(s.stops, 5);
  const may = sheet.stops.find((x) => x.label.startsWith('827 May'));
  assert.equal(may.order_count, 2);
  assert.equal(sheet.stops.at(-1).kind, 'shipping');

  await setDelivered(T, may.stop_key, true);
  sheet = await buildSheet(T);
  assert.equal(sheet.summary.stops_done, 1);
  assert.ok(sheet.stops.find((x) => x.stop_key === may.stop_key).delivered_at);
  await setDelivered(T, may.stop_key, false);
  assert.equal((await buildSheet(T)).summary.stops_done, 0);

  await setExtrasOverride(T, 3);
  assert.equal((await buildSheet(T)).summary.to_bake, 16);
});
