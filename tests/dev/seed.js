// Sample data for the dev server: a realistic Thursday.
const { query } = require('../../db/client');
const { processEvent } = require('../../lib/stripeEvents');
const { subscriptionEvent, fakeStripe, secs } = require('../helpers/fixtures');
const so = require('../../lib/standingOrders');
const { todayCentral, shiftDate } = require('../../lib/dates');

module.exports = async function seed() {
  let t = todayCentral();
  while (new Date(`${t}T12:00:00Z`).getUTCDay() !== 4) t = shiftDate(t, 1);
  const add = (f) => query(
    `INSERT INTO orders (source, order_type, cadence, payment_status, customer_name, customer_email, customer_phone, loaves, fulfillment_type, delivery_method, pickup_location, shipping_address, fulfillment_date, note, refunded_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'local',$9,$10,$11,$12,$13,$14)`,
    [f.source || 'stripe', f.type || 'subscription', f.cadence || 'weekly', f.status || 'paid', f.name, f.email || null, f.phone || null, f.loaves, f.method,
     f.pickup || null, f.addr ? JSON.stringify(f.addr) : null, f.date || t, f.note || null, f.refunded || 0],
  );
  const a = (line1, city, zip) => ({ line1, city, state: 'IL', postal_code: zip, country: 'US' });
  await add({ name: 'Linda Strong', email: 'linda@example.com', loaves: 1, method: 'local_delivery', addr: a('128 S 6th St', 'Geneva', '60134') });
  await add({ name: 'Michael Hurrle', email: 'mike@example.com', phone: '6305550101', loaves: 1, method: 'local_delivery', addr: a('827 May St', 'Geneva', '60134') });
  await add({ name: 'Sam Hurrle', loaves: 2, method: 'local_delivery', addr: a('827 May Street', 'Geneva', '60134'), type: 'onetime', note: 'Leave by the side door' });
  await add({ name: 'Cameron Hopf', email: 'cam@example.com', loaves: 1, method: 'local_delivery', addr: a('825 May St', 'Geneva', '60134'), status: 'declined' });
  await add({ name: 'Vincent Anter', loaves: 1, method: 'local_delivery', addr: a('1606 Bentz Way', 'Batavia', '60510'), refunded: 500 });
  await add({ name: 'Bert Berry', loaves: 3, method: 'pickup', pickup: 'Energy City Brewing — Batavia' });
  await add({ name: 'Neighbor Kim', loaves: 1, method: 'pickup', pickup: 'Energy City Brewing — Batavia', source: 'manual', type: 'manual', status: 'unpaid' });
  await add({ name: 'Allen Douglas', email: 'allen@example.com', loaves: 2, method: 'shipped', addr: { name: 'Allen Douglas', ...a('3542 Prairie Ave', 'Brookfield', '60513') }, type: 'onetime' });
  await add({ name: 'Raymond Gicela', loaves: 1, method: 'shipped', addr: a('28W660 Hickory Ln', 'West Chicago', '60185') });
  await so.create({ name: 'Coffee Shop (barter)', loaves: 2, delivery_method: 'pickup', pickup_location: 'CM Florals — St. Charles', frequency: 'weekly', start_date: shiftDate(t, -14) });
  // A monthly subscriber charging Wednesday: shows as Expected.
  const wedTen = Math.floor(new Date(`${shiftDate(t, -1)}T16:00:00Z`).getTime() / 1000);
  await processEvent(subscriptionEvent('customer.subscription.updated', { created: '2026-11-01T00:00:00Z', sub: { id: 'sub_month', current_period_end: wedTen } }), fakeStripe());
  return t;
};
