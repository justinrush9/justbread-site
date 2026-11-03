/**
 * The bake sheet for one Thursday (SPEC.md section 7), built on the server so
 * every number is tested in one place. Combines:
 *   - orders (Stripe paid/declined, manual), minus refunded and cancelled
 *   - expected renewals not charged yet (4c)
 *   - standing orders (6b)
 * and groups them into stops (7c): one per unique local address, one per
 * pickup point, one for all shipping.
 */

const { query } = require('../db/client');
const { expectedFor } = require('./expected');
const { entriesFor: standingFor } = require('./standingOrders');
const { asDateStr } = require('./dates');

// Baker's dozen: 1 extra per 12 ordered (9b), unless overridden for the week.
const extrasFor = (ordered, override) => (Number.isInteger(override) ? override : Math.floor(ordered / 12));

function normalizeAddress(a) {
  if (!a) return null;
  const line1 = String(a.line1 || '').toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street)\b/g, 'st').replace(/\b(avenue)\b/g, 'ave').replace(/\b(drive)\b/g, 'dr')
    .replace(/\b(lane)\b/g, 'ln').replace(/\b(court)\b/g, 'ct').replace(/\b(road)\b/g, 'rd')
    .replace(/\s+/g, ' ').trim();
  const zip = String(a.postal_code || '').slice(0, 5);
  return line1 ? `addr:${line1}|${zip}` : null;
}

function stopKeyFor(e) {
  if (e.delivery_method === 'shipped') return 'shipping';
  if (e.delivery_method === 'pickup') return `pickup:${e.pickup_location || 'unknown'}`;
  return normalizeAddress(e.shipping_address) || `order:${e.id ?? e.stripe_subscription_id ?? e.standing_order_id}`;
}

function addressLine(a) {
  if (!a) return '';
  return [a.line1, a.line2, a.city, [a.state, a.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

function sourceTag(e) {
  if (e.source === 'standing') return 'Barter';
  if (e.source === 'manual') return 'Manual';
  if (e.kind === 'expected') return 'Subscription';
  return e.order_type === 'subscription' ? 'Subscription' : 'One-time';
}

async function buildSheet(thursday) {
  const [{ rows: orderRows }, expected, standing, { rows: stopRows }, { rows: [override] }] = await Promise.all([
    query(
      `SELECT * FROM orders
       WHERE fulfillment_date = $1 AND payment_status <> 'refunded' AND cancelled_at IS NULL
       ORDER BY customer_name NULLS LAST, id`,
      [thursday],
    ),
    expectedFor(thursday),
    standingFor(thursday),
    query('SELECT * FROM stops WHERE fulfillment_date = $1', [thursday]),
    query('SELECT * FROM week_overrides WHERE fulfillment_date = $1', [thursday]),
  ]);

  const entries = [
    ...orderRows.map((o) => ({ kind: 'order', ...o })),
    ...expected.map((e) => ({ kind: 'expected', source: 'stripe', order_type: 'subscription', payment_status: 'expected', ...e })),
    ...standing.map((e) => ({ kind: 'standing', ...e })),
  ].map((e) => ({
    id: e.kind === 'order' ? e.id : null,
    kind: e.kind,
    source_tag: sourceTag(e),
    customer_name: e.customer_name || e.customer_email || 'Customer',
    customer_email: e.customer_email || null,
    customer_phone: e.customer_phone || null,
    loaves: e.loaves || 0,
    delivery_method: e.delivery_method,
    pickup_location: e.pickup_location || null,
    address: e.shipping_address || null,
    address_line: addressLine(e.shipping_address),
    note: e.note || null,
    payment_status: e.payment_status,
    declined: e.payment_status === 'declined' && !e.declined_resolved_at,
    refunded_cents: e.refunded_cents || 0,
    expected_charge_at: e.charges_at || null,
    skipped: !!e.skipped,
    stripe_subscription_id: e.stripe_subscription_id || null,
    standing_order_id: e.standing_order_id || null,
    stop_key: stopKeyFor(e),
  }));

  const counted = entries.filter((e) => !e.skipped);
  const ordered = counted.reduce((s, e) => s + e.loaves, 0);
  const extras = extrasFor(ordered, override?.extras_override);
  const byMethod = (m) => counted.filter((e) => e.delivery_method === m).reduce((s, e) => s + e.loaves, 0);

  // Stops (7a / 7c). Skipped entries don't make a stop on their own.
  const deliveredBy = new Map(stopRows.map((s) => [s.stop_key, s]));
  const stopMap = new Map();
  for (const e of counted) {
    if (!stopMap.has(e.stop_key)) {
      const kind = e.delivery_method === 'shipped' ? 'shipping' : e.delivery_method;
      stopMap.set(e.stop_key, {
        stop_key: e.stop_key,
        kind,
        label: kind === 'shipping' ? 'UPS (all shipped orders)' : kind === 'pickup' ? e.pickup_location : e.address_line || e.customer_name,
        address: kind === 'local_delivery' ? e.address : null,
        loaves: 0,
        order_count: 0,
        delivered_at: deliveredBy.get(e.stop_key)?.delivered_at || null,
        handed_off_at: deliveredBy.get(e.stop_key)?.handed_off_at || null,
        route_position: deliveredBy.get(e.stop_key)?.route_position ?? null,
      });
    }
    const s = stopMap.get(e.stop_key);
    s.loaves += e.loaves;
    s.order_count += 1;
  }
  const stops = [...stopMap.values()].sort((a, b) => {
    const rank = { local_delivery: 0, pickup: 1, shipping: 2 };
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    if (a.route_position != null && b.route_position != null) return a.route_position - b.route_position;
    return String(a.address?.postal_code || '').localeCompare(String(b.address?.postal_code || '')) || String(a.label).localeCompare(String(b.label));
  });

  return {
    thursday,
    summary: {
      ordered,
      extras,
      extras_overridden: Number.isInteger(override?.extras_override),
      to_bake: ordered + extras,
      expected_loaves: counted.filter((e) => e.kind === 'expected').reduce((s, e) => s + e.loaves, 0),
      local_loaves: byMethod('local_delivery'),
      pickup_loaves: byMethod('pickup'),
      shipped_loaves: byMethod('shipped'),
      stops: stops.length,
      stops_done: stops.filter((s) => s.delivered_at).length,
      stops_with_helper: stops.filter((s) => s.handed_off_at && !s.delivered_at).length,
      declined: counted.filter((e) => e.declined).length,
      manual_or_standing: counted.filter((e) => e.kind === 'standing' || e.source_tag === 'Manual').length,
    },
    stops,
    entries,
  };
}

/** Upcoming Thursdays that have anything on them, for the date chips. */
async function upcomingThursdays(today) {
  const { rows } = await query(
    `SELECT DISTINCT fulfillment_date AS d FROM orders
     WHERE fulfillment_date >= ($1::date - INTERVAL '7 days') AND payment_status <> 'refunded' AND cancelled_at IS NULL
     ORDER BY d LIMIT 12`,
    [today],
  );
  return rows.map((r) => asDateStr(r.d));
}

async function setDelivered(thursday, stopKey, delivered, now = new Date()) {
  await query(
    `INSERT INTO stops (fulfillment_date, stop_key, kind, delivered_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (fulfillment_date, stop_key) DO UPDATE SET delivered_at = EXCLUDED.delivered_at`,
    [thursday, stopKey, stopKey === 'shipping' ? 'shipping' : stopKey.startsWith('pickup:') ? 'pickup' : 'local_delivery',
     delivered ? now.toISOString() : null],
  );
  if (delivered) await require('./customerEmails').onStopDelivered(thursday, stopKey);
  return { stop_key: stopKey, delivered };
}

/** Hand a stop to a helper (section 8): off Jay's route, no email yet. */
async function setHandedOff(thursday, stopKey, on, now = new Date()) {
  await query(
    `INSERT INTO stops (fulfillment_date, stop_key, kind, handed_off_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (fulfillment_date, stop_key) DO UPDATE SET handed_off_at = EXCLUDED.handed_off_at`,
    [thursday, stopKey, stopKey.startsWith('pickup:') ? 'pickup' : 'local_delivery', on ? now.toISOString() : null],
  );
  return { stop_key: stopKey, handed_off: !!on };
}

async function setExtrasOverride(thursday, extras) {
  await query(
    `INSERT INTO week_overrides (fulfillment_date, extras_override) VALUES ($1, $2)
     ON CONFLICT (fulfillment_date) DO UPDATE SET extras_override = EXCLUDED.extras_override`,
    [thursday, Number.isInteger(extras) ? extras : null],
  );
  return { extras_override: Number.isInteger(extras) ? extras : null };
}

module.exports = { buildSheet, upcomingThursdays, setDelivered, setHandedOff, setExtrasOverride, extrasFor, normalizeAddress, stopKeyFor };
