/**
 * Standing (barter) orders, SPEC.md 6b.
 *
 * Future Thursdays are calculated from the standing order's current rules,
 * never stored, so an edit changes every future Thursday at once. A row in
 * standing_order_occurrences exists only when something happened to one
 * Thursday:
 *   skipped  Jay skipped that Thursday
 *   frozen   a past Thursday, locked with the values it had (daily cron), or
 *            a one-Thursday override from a single-order edit (6c)
 * Frozen rows win over the rules, so later edits never rewrite history.
 */

const { query } = require('../db/client');
const { isThursday, daysBetween, asDateStr, todayCentral, thursdaysBetween, shiftDate } = require('./dates');

class StandingOrderError extends Error {}

const METHODS = new Set(['pickup', 'local_delivery', 'shipped']);

// Does the standing order's schedule include this Thursday (ignoring pause)?
function scheduledOn(so, thursday) {
  const start = asDateStr(so.start_date);
  const end = asDateStr(so.end_date);
  if (thursday < start) return false;
  if (end && thursday > end) return false;
  if (so.frequency === 'weekly') return true;
  if (so.frequency === 'biweekly') return daysBetween(start, thursday) % 14 === 0;
  return false;
}

function entryFrom(so, values, state) {
  return {
    source: 'standing',
    standing_order_id: so.id,
    customer_name: so.name,
    customer_email: so.email,
    customer_phone: so.phone,
    loaves: values.loaves,
    delivery_method: values.delivery_method,
    shipping_address: values.address,
    pickup_location: values.pickup_location,
    note: values.note ?? so.note,
    payment_status: 'n/a',
    order_type: 'standing',
    skipped: state === 'skipped',
  };
}

/** Standing-order entries for one Thursday (skipped ones flagged, not counted). */
async function entriesFor(thursday) {
  const [{ rows: orders }, { rows: occs }] = await Promise.all([
    query('SELECT * FROM standing_orders ORDER BY id'),
    query('SELECT * FROM standing_order_occurrences WHERE fulfillment_date = $1', [thursday]),
  ]);
  const occBy = new Map(occs.map((o) => [o.standing_order_id, o]));
  const out = [];
  for (const so of orders) {
    const occ = occBy.get(so.id);
    if (occ?.state === 'frozen') {
      out.push(entryFrom(so, occ, 'frozen'));
    } else if (scheduledOn(so, thursday)) {
      if (occ?.state === 'skipped') out.push(entryFrom(so, so, 'skipped'));
      else if (!so.paused) out.push(entryFrom(so, { ...so, note: so.note }, 'live'));
    }
  }
  return out;
}

/**
 * Daily cron: lock every past Thursday (last 3 weeks) that a standing order
 * delivered, with the values it had. Idempotent.
 */
async function freezePast(today = todayCentral()) {
  const { rows: orders } = await query('SELECT * FROM standing_orders');
  let frozen = 0;
  for (const thursday of thursdaysBetween(shiftDate(today, -21), today)) {
    for (const so of orders) {
      if (so.paused || !scheduledOn(so, thursday)) continue;
      const r = await query(
        `INSERT INTO standing_order_occurrences
           (standing_order_id, fulfillment_date, state, loaves, delivery_method, address, pickup_location, note)
         VALUES ($1, $2, 'frozen', $3, $4, $5, $6, $7)
         ON CONFLICT (standing_order_id, fulfillment_date) DO NOTHING
         RETURNING id`,
        [so.id, thursday, so.loaves, so.delivery_method,
         so.address ? JSON.stringify(so.address) : null, so.pickup_location, so.note],
      );
      frozen += r.rowCount;
    }
  }
  return { frozen };
}

function validate(f, { partial = false } = {}) {
  const need = (k) => !partial || k in f;
  if (need('name') && !f.name) throw new StandingOrderError('Name is required.');
  if (need('loaves') && !(Number.isInteger(f.loaves) && f.loaves > 0)) throw new StandingOrderError('Loaves must be a whole number above 0.');
  if (need('delivery_method') && !METHODS.has(f.delivery_method)) throw new StandingOrderError('Pick local delivery, pickup, or shipped.');
  if (need('frequency') && !['weekly', 'biweekly'].includes(f.frequency)) throw new StandingOrderError('Frequency must be weekly or every other week.');
  if (need('start_date') && !isThursday(f.start_date)) throw new StandingOrderError('Start date must be a Thursday.');
  if (f.end_date && !isThursday(f.end_date)) throw new StandingOrderError('End date must be a Thursday.');
  if ('delivery_method' in f) {
    if (['local_delivery', 'shipped'].includes(f.delivery_method) && !f.address) throw new StandingOrderError('Address is required for local delivery and shipping.');
    if (f.delivery_method === 'pickup' && !f.pickup_location) throw new StandingOrderError('Pickup point is required.');
  }
}

const FIELDS = ['name', 'email', 'phone', 'loaves', 'delivery_method', 'address', 'pickup_location', 'frequency', 'start_date', 'end_date', 'note'];

async function create(f) {
  validate(f);
  const vals = FIELDS.map((k) => (k === 'address' && f[k] ? JSON.stringify(f[k]) : f[k] ?? null));
  const r = await query(
    `INSERT INTO standing_orders (${FIELDS.join(', ')}) VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    vals,
  );
  return r.rows[0];
}

async function update(id, f) {
  const keys = Object.keys(f).filter((k) => FIELDS.includes(k));
  if (!keys.length) throw new StandingOrderError('Nothing to change.');
  const { rows: [current] } = await query('SELECT * FROM standing_orders WHERE id = $1', [id]);
  if (!current) throw new StandingOrderError('No such standing order.');
  validate({ ...current, start_date: asDateStr(current.start_date), end_date: asDateStr(current.end_date), ...f }, { partial: false });
  const vals = keys.map((k) => (k === 'address' && f[k] ? JSON.stringify(f[k]) : f[k] ?? null));
  const r = await query(
    `UPDATE standing_orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...vals],
  );
  return r.rows[0];
}

async function skip(id, thursday, today = todayCentral()) {
  if (!isThursday(thursday)) throw new StandingOrderError(`${thursday} is not a Thursday.`);
  if (thursday < today) throw new StandingOrderError('That Thursday has passed.');
  await query(
    `INSERT INTO standing_order_occurrences (standing_order_id, fulfillment_date, state)
     VALUES ($1, $2, 'skipped')
     ON CONFLICT (standing_order_id, fulfillment_date) DO UPDATE SET state = 'skipped'`,
    [id, thursday],
  );
  return { skipped: thursday };
}

async function unskip(id, thursday) {
  await query(`DELETE FROM standing_order_occurrences WHERE standing_order_id = $1 AND fulfillment_date = $2 AND state = 'skipped'`, [id, thursday]);
  return { unskipped: thursday };
}

const pause = (id) => query('UPDATE standing_orders SET paused = true, updated_at = now() WHERE id = $1', [id]).then(() => ({ paused: true }));
const resume = (id) => query('UPDATE standing_orders SET paused = false, updated_at = now() WHERE id = $1', [id]).then(() => ({ paused: false }));

/** End it: the last Thursday it delivers is the last one before `today` unless told otherwise. */
async function end(id, lastThursday) {
  if (!isThursday(lastThursday)) throw new StandingOrderError('Last Thursday must be a Thursday.');
  await query('UPDATE standing_orders SET end_date = $2, updated_at = now() WHERE id = $1', [id, lastThursday]);
  return { end_date: lastThursday };
}

/** One-Thursday override from a single-order edit (6c): loaves or note for that day only. */
async function overrideOne(id, thursday, { loaves, note }) {
  const { rows: [so] } = await query('SELECT * FROM standing_orders WHERE id = $1', [id]);
  if (!so) throw new StandingOrderError('No such standing order.');
  if (!scheduledOn(so, thursday)) throw new StandingOrderError('That standing order does not deliver that Thursday.');
  await query(
    `INSERT INTO standing_order_occurrences
       (standing_order_id, fulfillment_date, state, loaves, delivery_method, address, pickup_location, note)
     VALUES ($1, $2, 'frozen', $3, $4, $5, $6, $7)
     ON CONFLICT (standing_order_id, fulfillment_date) DO UPDATE SET
       state = 'frozen', loaves = EXCLUDED.loaves, note = EXCLUDED.note`,
    [id, thursday, loaves ?? so.loaves, so.delivery_method,
     so.address ? JSON.stringify(so.address) : null, so.pickup_location, note ?? so.note],
  );
  return { overridden: thursday };
}

module.exports = {
  scheduledOn, entriesFor, freezePast, create, update, skip, unskip, pause, resume, end, overrideOne, StandingOrderError,
};
