// SPEC.md 9e: how did you hear about us.
const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const r = require('../../lib/referrals');

const session = (over = {}) => ({ id: 'cs_new', status: 'complete', payment_status: 'paid', created: Math.floor(Date.now() / 1000), customer_details: { email: 'New@Example.com' }, ...over });
const fake = (s) => ({ checkout: { sessions: { retrieve: async (id) => { if (!s || id !== s.id) throw new Error('No such session'); return s; } } } });

test('asks first-time customers once, records the answer', async () => {
  await freshDb();
  const st = fake(session());
  const a = await r.shouldAsk(st, 'cs_new');
  assert.equal(a.ask, true);
  assert.deepEqual(a.choices.map((c) => c.label), ['Google / internet search', 'Instagram', 'Friend or family', 'Another customer', 'Farmers market', 'Other']);
  await r.record(st, 'cs_new', 'other', '  Geneva Patch  ');
  await r.record(st, 'cs_new', 'instagram'); // second answer ignored
  assert.equal((await r.shouldAsk(st, 'cs_new')).ask, false);
  const sum = await r.summary();
  assert.equal(sum.counts.find((c) => c.value === 'other').last_90, 1);
  assert.equal(sum.counts.find((c) => c.value === 'instagram').all_time, 0);
  assert.equal(sum.recent[0].other_text, 'Geneva Patch');
});

test('returning customers, unpaid or fake sessions are not asked', async () => {
  const db = await freshDb();
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_email, loaves, fulfillment_type, delivery_method, created_at)
    VALUES ('stripe','onetime','paid','new@example.com',1,'local','local_delivery', now() - INTERVAL '30 days')`);
  assert.equal((await r.shouldAsk(fake(session()), 'cs_new')).ask, false);
  // This checkout's own order (just landed) doesn't make them "returning".
  await db.query(`DELETE FROM orders`);
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_email, loaves, fulfillment_type, delivery_method)
    VALUES ('stripe','onetime','paid','new@example.com',1,'local','local_delivery')`);
  assert.equal((await r.shouldAsk(fake(session()), 'cs_new')).ask, true);
  assert.equal((await r.shouldAsk(fake(session({ payment_status: 'unpaid' })), 'cs_new')).ask, false);
  assert.equal((await r.shouldAsk(fake(null), 'cs_nope')).ask, false);
  assert.equal((await r.shouldAsk(fake(session()), 'not-a-session')).ask, false);
  await assert.rejects(r.record(fake(session()), 'cs_new', 'tiktok'), /Unknown choice/);
  await assert.rejects(r.record(fake(null), 'cs_x', 'search'), /Order not found/);
});
