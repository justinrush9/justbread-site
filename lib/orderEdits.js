/**
 * Manual one-time orders (SPEC.md 6a) and single-order edits (6c).
 * Nothing here writes to Stripe. Every edit is appended to orders.history.
 */

const { query } = require('../db/client');
const { isThursday } = require('./dates');

class OrderEditError extends Error {}

const METHODS = new Set(['pickup', 'local_delivery', 'shipped']);

async function createManual(f) {
  if (!f.name) throw new OrderEditError('Name is required.');
  if (!(Number.isInteger(f.loaves) && f.loaves > 0)) throw new OrderEditError('Loaves must be a whole number above 0.');
  if (!METHODS.has(f.delivery_method)) throw new OrderEditError('Pick local delivery, pickup, or shipped.');
  if (['local_delivery', 'shipped'].includes(f.delivery_method) && !f.address) throw new OrderEditError('Address is required for local delivery and shipping.');
  if (f.delivery_method === 'pickup' && !f.pickup_location) throw new OrderEditError('Pickup point is required.');
  if (!isThursday(f.thursday)) throw new OrderEditError('Pick the Thursday it goes on.');

  const r = await query(
    `INSERT INTO orders (
       source, order_type, payment_status, customer_name, customer_email, customer_phone,
       loaves, fulfillment_type, delivery_method, pickup_location, shipping_address,
       fulfillment_date, note, amount_cents
     ) VALUES ('manual', 'manual', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0)
     RETURNING *`,
    [f.paid ? 'paid' : 'unpaid', f.name, f.email || null, f.phone || null, f.loaves,
     f.delivery_method === 'shipped' ? 'shipped' : 'local', f.delivery_method,
     f.delivery_method === 'pickup' ? f.pickup_location : null,
     f.delivery_method === 'pickup' ? null : JSON.stringify(f.address),
     f.thursday, f.note || null],
  );
  return r.rows[0];
}

// Fields a single-order edit may change, and how each is validated.
const EDITABLE = {
  fulfillment_date: (v) => { if (!isThursday(v)) throw new OrderEditError('Move it to a Thursday.'); return v; },
  loaves: (v) => { if (!(Number.isInteger(v) && v > 0)) throw new OrderEditError('Loaves must be a whole number above 0.'); return v; },
  shipping_address: (v) => JSON.stringify(v),
  customer_phone: (v) => v || null,
  note: (v) => v || null,
};

async function editOrder(id, changes, now = new Date()) {
  const keys = Object.keys(changes).filter((k) => k in EDITABLE);
  if (!keys.length) throw new OrderEditError('Nothing to change.');
  const { rows: [order] } = await query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!order) throw new OrderEditError('No such order.');
  if (order.cancelled_at) throw new OrderEditError('That delivery was cancelled.');
  if ('shipping_address' in changes && order.delivery_method === 'pickup') throw new OrderEditError('Pickup orders have no address.');

  const vals = keys.map((k) => EDITABLE[k](changes[k]));
  const entries = keys.map((k) => ({
    field: k,
    old: k === 'fulfillment_date' && order[k] instanceof Date ? order[k].toISOString().slice(0, 10) : order[k],
    new: changes[k],
    at: now.toISOString(),
  }));
  const r = await query(
    `UPDATE orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
       history = history || $${keys.length + 2}::jsonb
     WHERE id = $1 RETURNING *`,
    [id, ...vals, JSON.stringify(entries)],
  );
  const updated = r.rows[0];
  if ('fulfillment_date' in changes && entries[0]) {
    const moved = entries.find((x) => x.field === 'fulfillment_date');
    if (moved && moved.old !== moved.new) {
      await require('./customerEmails').onOrderChanged(updated, 'moved', { from: moved.old, to: moved.new });
    }
  }
  return updated;
}

/** Take one delivery off the sheet. Does not refund (refund in Stripe; it syncs back). */
async function cancelDelivery(id, now = new Date()) {
  const r = await query(
    `UPDATE orders SET cancelled_at = $2,
       history = history || $3::jsonb
     WHERE id = $1 AND cancelled_at IS NULL RETURNING *`,
    [id, now.toISOString(), JSON.stringify([{ field: 'cancelled', old: null, new: true, at: now.toISOString() }])],
  );
  if (!r.rowCount) throw new OrderEditError('No such order, or already cancelled.');
  const o = r.rows[0];
  await require('./customerEmails').onOrderChanged(o, 'cancelled', { date: o.fulfillment_date instanceof Date ? o.fulfillment_date.toISOString().slice(0, 10) : String(o.fulfillment_date).slice(0, 10) });
  return o;
}

/** Clear the Declined flag once Jay has handled it (7b). */
async function resolveDeclined(id, now = new Date()) {
  const r = await query(
    `UPDATE orders SET declined_resolved_at = $2 WHERE id = $1 AND payment_status = 'declined' RETURNING id`,
    [id, now.toISOString()],
  );
  if (!r.rowCount) throw new OrderEditError('That order is not declined.');
  return { resolved: true };
}

module.exports = { createManual, editOrder, cancelDelivery, resolveDeclined, OrderEditError };
