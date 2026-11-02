const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const so = require('../../lib/standingOrders');
const edits = require('../../lib/orderEdits');

const addr = { line1: '1 Main St', city: 'Geneva', state: 'IL', postal_code: '60134' };
const base = { name: 'Coffee Shop', loaves: 2, delivery_method: 'local_delivery', address: addr, frequency: 'weekly', start_date: '2026-11-05' };
const loavesOn = async (d) => (await so.entriesFor(d)).filter((e) => !e.skipped).map((e) => e.loaves);

test('weekly standing order: every Thursday from start; skip one; end it', async () => {
  await freshDb();
  const o = await so.create(base);
  assert.deepEqual(await loavesOn('2026-10-29'), [], 'nothing before start');
  for (const d of ['2026-11-05', '2026-11-12', '2026-11-19', '2027-02-04']) assert.deepEqual(await loavesOn(d), [2], d);

  await so.skip(o.id, '2026-11-19', '2026-11-10');
  assert.deepEqual(await loavesOn('2026-11-19'), []);
  assert.equal((await so.entriesFor('2026-11-19'))[0].skipped, true, 'shown greyed');
  assert.deepEqual(await loavesOn('2026-11-26'), [2], 'skip affects only that Thursday');
  await so.unskip(o.id, '2026-11-19');
  assert.deepEqual(await loavesOn('2026-11-19'), [2]);

  await so.freezePast('2026-11-20'); // cron on Fri Nov 20: locks Nov 5, 12, 19
  await so.end(o.id, '2026-11-26');
  assert.deepEqual(await loavesOn('2026-11-19'), [2], 'earlier Thursdays unchanged');
  assert.deepEqual(await loavesOn('2026-11-26'), [2], 'last Thursday still delivers');
  assert.deepEqual(await loavesOn('2026-12-03'), [], 'removed from all later Thursdays');
});

test('every other week alternates from the start date, across a month boundary', async () => {
  await freshDb();
  await so.create({ ...base, frequency: 'biweekly', start_date: '2026-11-19' });
  const on = [];
  for (const d of ['2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-31', '2027-01-14']) {
    if ((await loavesOn(d)).length) on.push(d);
  }
  assert.deepEqual(on, ['2026-11-19', '2026-12-03', '2026-12-17', '2026-12-31', '2027-01-14']);
});

test('pause and resume', async () => {
  await freshDb();
  const o = await so.create(base);
  await so.pause(o.id);
  assert.deepEqual(await loavesOn('2026-11-12'), []);
  await so.resume(o.id);
  assert.deepEqual(await loavesOn('2026-11-12'), [2]);
});

test('an edit changes every future Thursday and no past (frozen) one', async () => {
  await freshDb();
  const o = await so.create(base);
  await so.freezePast('2026-11-14'); // Sat: freezes Nov 5 and Nov 12
  await so.update(o.id, { loaves: 3 });
  assert.deepEqual(await loavesOn('2026-11-05'), [2]);
  assert.deepEqual(await loavesOn('2026-11-12'), [2]);
  assert.deepEqual(await loavesOn('2026-11-19'), [3]);
  assert.deepEqual(await loavesOn('2027-01-07'), [3]);
  await so.freezePast('2026-11-14'); // idempotent
  assert.equal((await so.freezePast('2026-11-14')).frozen, 0);
});

test('one-Thursday override from a single edit, and validation', async () => {
  await freshDb();
  const o = await so.create(base);
  await so.overrideOne(o.id, '2026-11-19', { loaves: 5, note: 'party' });
  assert.deepEqual(await loavesOn('2026-11-19'), [5]);
  assert.deepEqual(await loavesOn('2026-11-26'), [2]);
  await assert.rejects(so.create({ ...base, start_date: '2026-11-06' }), /Thursday/);
  await assert.rejects(so.create({ ...base, address: null }), /Address/);
  await assert.rejects(so.skip(o.id, '2026-11-05', '2026-11-10'), /passed/);
});

test('manual order, edits with history, cancel, resolve declined', async () => {
  const db = await freshDb();
  const m = await edits.createManual({ name: 'Neighbor', loaves: 1, delivery_method: 'pickup', pickup_location: 'Energy City Brewing — Batavia', thursday: '2026-11-12', paid: false });
  assert.equal(m.source, 'manual');
  assert.equal(m.payment_status, 'unpaid');
  await assert.rejects(edits.createManual({ name: 'X', loaves: 1, delivery_method: 'local_delivery', thursday: '2026-11-12' }), /Address/);

  const moved = await edits.editOrder(m.id, { fulfillment_date: '2026-11-19', loaves: 2 });
  assert.equal(moved.loaves, 2);
  assert.deepEqual(moved.history.map((h) => [h.field, h.old, h.new]), [['fulfillment_date', '2026-11-12', '2026-11-19'], ['loaves', 1, 2]]);
  await assert.rejects(edits.editOrder(m.id, { fulfillment_date: '2026-11-20' }), /Thursday/);

  await edits.cancelDelivery(m.id);
  await assert.rejects(edits.cancelDelivery(m.id), /already cancelled/);
  await assert.rejects(edits.editOrder(m.id, { loaves: 3 }), /cancelled/);

  await db.query(`INSERT INTO orders (source, order_type, payment_status, loaves, fulfillment_type, fulfillment_date) VALUES ('stripe','subscription','declined',1,'local','2026-11-12')`);
  const { rows: [d] } = await db.query(`SELECT id FROM orders WHERE payment_status='declined'`);
  assert.deepEqual(await edits.resolveDeclined(d.id), { resolved: true });
});
