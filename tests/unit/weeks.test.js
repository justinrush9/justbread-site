// SPEC.md 7f: moving one week's delivery day (Thanksgiving -> Wednesday).
const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const { invoiceEvent, fakeStripe, secs, id } = require('../helpers/fixtures');
const { processEvent } = require('../../lib/stripeEvents');
const { PRICES } = require('../../lib/prices');
const weeks = require('../../lib/weeks');
const { buildSheet } = require('../../lib/sheet');
const plan = require('../../lib/productionPlan');
const { firstRenewalEpoch } = require('../../lib/billingAnchor');
const { chicagoTimeToEpoch } = require('../../lib/fulfillment');

const THU = '2026-11-26';
const WED = '2026-11-25';

test('delivery day: default Thursday, set Wednesday, reset, bounds', async () => {
  await freshDb();
  assert.equal(await weeks.deliveryDateFor(THU), THU);
  assert.equal(await weeks.setDeliveryDate(THU, WED), WED);
  assert.deepEqual(await weeks.deliveryDates([THU, '2026-12-03']), { [THU]: WED, '2026-12-03': '2026-12-03' });
  assert.equal((await buildSheet(THU)).delivery_date, WED);
  await assert.rejects(weeks.setDeliveryDate(THU, '2026-11-23'), /Tuesday through Friday/);
  await assert.rejects(weeks.setDeliveryDate(THU, '2026-11-28'), /Tuesday through Friday/);
  assert.equal(await weeks.setDeliveryDate(THU, THU), THU); // back to normal
  assert.equal((await buildSheet(THU)).delivery_date, THU);
});

test('moved-earlier week: new-order cutoff is Monday noon, renewals stay put', async () => {
  await freshDb();
  await weeks.setDeliveryDate(THU, WED);
  // Central is UTC-6 in November.
  assert.equal(await weeks.applyMovedCutoff(new Date('2026-11-23T18:00:00Z'), THU), THU); // Mon 12:00 PM
  assert.equal(await weeks.applyMovedCutoff(new Date('2026-11-23T18:01:00Z'), THU), '2026-12-03'); // Mon 12:01 PM
  assert.equal(await weeks.applyMovedCutoff(new Date('2026-11-24T15:00:00Z'), THU), '2026-12-03'); // Tue 9 AM

  // One-time order Monday afternoon -> next week.
  const ev = {
    id: id('evt'), type: 'checkout.session.completed', created: secs('2026-11-23T20:00:00Z'),
    data: { object: {
      id: 'cs_tg', mode: 'payment', payment_status: 'paid', customer: 'cus_T', payment_intent: 'pi_tg',
      created: secs('2026-11-23T20:00:00Z'), amount_total: 1700, metadata: {},
      customer_details: { email: 't@example.com', name: 'Tg', address: { postal_code: '60134' } },
    } },
  };
  await processEvent(ev, fakeStripe({ lineItems: [{ price: { id: PRICES.loaf.onetime }, quantity: 1 }, { price: { id: PRICES.localOnetime }, quantity: 1 }] }));
  // A renewal charging Wednesday afternoon of the moved week still belongs to it.
  await processEvent(invoiceEvent('invoice.paid', { invoiceId: 'in_wed', created: '2026-11-25T21:00:00Z' }), fakeStripe());
  const { query } = require('../../db/client');
  const { rows } = await query("SELECT stripe_invoice_id, to_char(fulfillment_date,'YYYY-MM-DD') d FROM orders ORDER BY id");
  assert.deepEqual(rows.map((r) => r.d), ['2026-12-03', THU]);
});

test('a later delivery day (Friday) keeps the normal Tuesday noon cutoff', async () => {
  await freshDb();
  await weeks.setDeliveryDate('2026-12-03', '2026-12-04');
  assert.equal(await weeks.applyMovedCutoff(new Date('2026-12-01T17:00:00Z'), '2026-12-03'), '2026-12-03'); // Tue 11 AM
});

test('first renewal anchors off the real first week', () => {
  const paid = new Date('2026-11-23T20:00:00Z'); // Mon 2 PM, after the moved cutoff
  assert.equal(firstRenewalEpoch(paid, 'weekly', '2026-12-03'), chicagoTimeToEpoch('2026-12-07', 6));
  assert.equal(firstRenewalEpoch(paid, 'weekly'), chicagoTimeToEpoch('2026-11-30', 6)); // unchanged default
});

test('production schedule shifts a day earlier and says so', async () => {
  const db = await freshDb();
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_name, loaves, fulfillment_type, delivery_method, fulfillment_date)
    VALUES ('stripe','onetime','paid','A',4,'local','local_delivery',$1)`, [THU]);
  await weeks.setDeliveryDate(THU, WED);
  const p = await plan.planFor(THU);
  assert.equal(p.delivery_date, WED);
  assert.deepEqual(p.days, { feed: '2026-11-23', mix: '2026-11-24', bake: WED });
  await plan.markStarted(THU, 'mix');
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_name, loaves, fulfillment_type, delivery_method, fulfillment_date)
    VALUES ('manual','onetime','paid','B',1,'local','local_delivery',$1)`, [THU]);
  const after = await plan.planFor(THU);
  assert.equal(after.changes[0].label, 'Tuesday dough mix');
});
