/**
 * A week's actual delivery day (SPEC.md 7f). Every week is keyed by its
 * Thursday; week_overrides.delivery_date moves the day bread goes out
 * (e.g. Thanksgiving week -> Wednesday). Null means Thursday.
 */

const { query } = require('../db/client');
const { asDateStr, daysBetween, shiftDate, isThursday } = require('./dates');
const { chicagoParts } = require('./fulfillment');

// Allowed: Tuesday (-2) through Friday (+1) of the same week.
const MIN_SHIFT = -2;
const MAX_SHIFT = 1;

async function deliveryDates(thursdays) {
  const list = [...new Set(thursdays.filter(Boolean))];
  const out = Object.fromEntries(list.map((t) => [t, t]));
  if (!list.length) return out;
  const { rows } = await query(
    'SELECT fulfillment_date, delivery_date FROM week_overrides WHERE fulfillment_date = ANY($1::date[]) AND delivery_date IS NOT NULL',
    [list],
  );
  for (const r of rows) out[asDateStr(r.fulfillment_date)] = asDateStr(r.delivery_date);
  return out;
}

async function deliveryDateFor(thursday) {
  if (!thursday) return thursday;
  return (await deliveryDates([thursday]))[thursday];
}

async function setDeliveryDate(thursday, date) {
  if (!isThursday(thursday)) throw new Error('Week must be given by its Thursday');
  if (date === thursday) date = null;
  if (date != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Delivery day must be YYYY-MM-DD');
    const shift = daysBetween(thursday, date);
    if (shift < MIN_SHIFT || shift > MAX_SHIFT) throw new Error('Delivery day must be Tuesday through Friday of the same week');
  }
  await query(
    `INSERT INTO week_overrides (fulfillment_date, delivery_date) VALUES ($1, $2)
     ON CONFLICT (fulfillment_date) DO UPDATE SET delivery_date = EXCLUDED.delivery_date`,
    [thursday, date],
  );
  return deliveryDateFor(thursday);
}

/**
 * Rule 4 with 7f applied: a new order placed for `thursday`'s week after
 * that week's (moved-earlier) cutoff goes to the next week. Cutoff is noon,
 * two days before the delivery day; it only ever moves earlier.
 */
async function applyMovedCutoff(placedAt, thursday) {
  if (!thursday) return thursday;
  for (let i = 0; i < 3; i++) {
    const delivery = await deliveryDateFor(thursday);
    const shift = daysBetween(thursday, delivery);
    if (shift >= 0) return thursday;
    const cutoffDay = shiftDate(delivery, -2);
    const p = chicagoParts(placedAt instanceof Date ? placedAt : new Date(placedAt));
    const day = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    const past = day > cutoffDay || (day === cutoffDay && (p.hour > 12 || (p.hour === 12 && p.minute > 0)));
    if (!past) return thursday;
    thursday = shiftDate(thursday, 7);
  }
  return thursday;
}

module.exports = { deliveryDates, deliveryDateFor, setDeliveryDate, applyMovedCutoff, MIN_SHIFT, MAX_SHIFT };
