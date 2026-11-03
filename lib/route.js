/**
 * Delivery route (SPEC.md section 8).
 *
 * Stops: every local delivery address and pickup point on the Thursday's
 * sheet (the UPS shipping stop is not part of the drive). Order: Google
 * Routes API computeRoutes with optimizeWaypointOrder, from home through
 * every stop and back home. Computed once per Thursday and stored; only
 * recomputed on "Re-optimize" or when the set of stops changes. Opening the
 * sheet never calls Google.
 *
 * Cost guardrails: the key lives only on the server; the app counts its own
 * calls and stops at DAILY_CAP; if optimization is unavailable for any reason
 * the stops fall back to ZIP-then-street order with a visible notice.
 */

const crypto = require('crypto');
const { query } = require('../db/client');
const { buildSheet } = require('./sheet');
const settings = require('./settings');
const { todayCentral } = require('./dates');

const DAILY_CAP = 150;
const FREE_PER_MONTH = 5000;
// Google caps intermediate waypoints per computeRoutes request.
const MAX_INTERMEDIATES = 25;
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

function stopQuery(stop) {
  if (stop.kind === 'local_delivery' && stop.address) {
    const a = stop.address;
    return [a.line1, a.line2, a.city, a.state, a.postal_code].filter(Boolean).join(', ');
  }
  if (stop.kind === 'pickup') return stop.pickup_address || stop.label;
  return stop.label;
}

function hashStops(home, stops) {
  return crypto.createHash('sha1').update(JSON.stringify([home, stops.map((s) => s.stop_key).sort()])).digest('hex');
}

// Fallback: ZIP, then street name, then house number.
function fallbackOrder(stops) {
  const key = (s) => {
    const a = s.address || {};
    const m = String(a.line1 || s.label || '').match(/^\s*(\d+)\s+(.*)$/);
    return [String(a.postal_code || '99999'), (m ? m[2] : String(a.line1 || s.label || '')).toLowerCase(), m ? Number(m[1]) : 0];
  };
  return [...stops].sort((x, y) => {
    const a = key(x); const b = key(y);
    return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2];
  });
}

async function countCall(day) {
  const { rows: [r] } = await query(
    `INSERT INTO api_usage (day, service, count) VALUES ($1, 'google_routes', 1)
     ON CONFLICT (day, service) DO UPDATE SET count = api_usage.count + 1
     RETURNING count`,
    [day],
  );
  return r.count;
}

async function usage(day) {
  const month = day.slice(0, 7);
  const { rows } = await query(
    `SELECT COALESCE(SUM(count) FILTER (WHERE day = $1::date), 0)::int AS today,
            COALESCE(SUM(count) FILTER (WHERE to_char(day, 'YYYY-MM') = $2), 0)::int AS month
     FROM api_usage WHERE service = 'google_routes'`,
    [day, month],
  );
  return { today: rows[0].today, month: rows[0].month, daily_cap: DAILY_CAP, free_per_month: FREE_PER_MONTH };
}

/** One Google request: returns the optimized order of `stops`, or throws. */
async function optimizeOnce(fetchImpl, apiKey, home, stops, origin) {
  const body = {
    origin: origin || { address: home },
    destination: { address: home },
    intermediates: stops.map((s) => ({ address: stopQuery(s) })),
    travelMode: 'DRIVE',
    optimizeWaypointOrder: true,
  };
  const res = await fetchImpl(ROUTES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // Ask only for what we use: smaller response, no extra fields billed.
      'X-Goog-FieldMask': 'routes.optimizedIntermediateWaypointIndex,routes.duration,routes.distanceMeters',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Google returned ${res.status}`);
  const order = data.routes?.[0]?.optimizedIntermediateWaypointIndex;
  if (!Array.isArray(order) || order.length !== stops.length) throw new Error('Google returned no route');
  return { ordered: order.map((i) => stops[i]), duration: data.routes[0].duration, meters: data.routes[0].distanceMeters };
}

/**
 * Compute and store the route for a Thursday.
 * @param {object} o  { force: re-optimize even if the stop set is unchanged, fetchImpl, apiKey, today }
 */
async function computeRoute(thursday, o = {}) {
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const apiKey = o.apiKey ?? process.env.GOOGLE_ROUTES_API_KEY;
  const today = o.today || todayCentral();
  const home = await settings.get('home_address', null);
  const pickupAddresses = await settings.get('pickup_addresses', {});
  const sheet = await buildSheet(thursday);
  const stops = sheet.stops
    .filter((s) => s.kind === 'local_delivery' || s.kind === 'pickup')
    .map((s) => ({ ...s, pickup_address: s.kind === 'pickup' ? pickupAddresses[s.label] : undefined }));

  const hash = hashStops(home, stops);
  const { rows: [existing] } = await query('SELECT * FROM routes WHERE fulfillment_date = $1', [thursday]);
  if (existing && existing.stop_set_hash === hash && !o.force) {
    return { thursday, method: existing.method, notice: existing.notice, recomputed: false };
  }

  let ordered; let method = 'fallback'; let notice = null; let summary = null;
  if (!home) {
    notice = 'Set your home address to optimize the route. Stops are in ZIP order for now.';
  } else if (!stops.length) {
    ordered = []; method = 'google';
  } else if (!apiKey) {
    notice = 'Route optimization is not set up (no Google key). Stops are in ZIP order.';
  } else {
    const used = (await usage(today)).today;
    const chunks = stops.length > MAX_INTERMEDIATES
      ? [fallbackOrder(stops).slice(0, Math.ceil(stops.length / 2)), fallbackOrder(stops).slice(Math.ceil(stops.length / 2))]
      : [stops];
    if (used + chunks.length > DAILY_CAP) {
      notice = `Daily limit of ${DAILY_CAP} route optimizations reached. Stops are in ZIP order until tomorrow.`;
    } else {
      try {
        ordered = [];
        let seconds = 0; let meters = 0;
        for (const chunk of chunks) {
          await countCall(today); // counted before the call, so a crash can't undercount
          const r = await optimizeOnce(fetchImpl, apiKey, home, chunk);
          ordered.push(...r.ordered);
          seconds += parseInt(r.duration, 10) || 0; meters += r.meters || 0;
        }
        method = 'google';
        summary = { minutes: Math.round(seconds / 60), miles: Math.round((meters / 1609.34) * 10) / 10 };
        if (chunks.length > 1) notice = `${stops.length} stops is more than Google optimizes in one request, so the route was optimized in two halves.`;
      } catch (err) {
        ordered = undefined;
        notice = `Route optimization failed (${err.message}). Stops are in ZIP order.`;
      }
    }
  }
  if (!ordered) { ordered = fallbackOrder(stops); method = 'fallback'; }

  // Store positions on the stops (keeping any Delivered ticks) and the route row.
  for (const [i, s] of ordered.entries()) {
    await query(
      `INSERT INTO stops (fulfillment_date, stop_key, kind, label, route_position)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (fulfillment_date, stop_key) DO UPDATE SET route_position = EXCLUDED.route_position, label = EXCLUDED.label, kind = EXCLUDED.kind`,
      [thursday, s.stop_key, s.kind, s.label, i + 1],
    );
  }
  const fullNotice = [notice, summary ? `About ${summary.minutes} min, ${summary.miles} mi driving.` : null].filter(Boolean).join(' ') || null;
  await query(
    `INSERT INTO routes (fulfillment_date, computed_at, stop_set_hash, method, notice)
     VALUES ($1, now(), $2, $3, $4)
     ON CONFLICT (fulfillment_date) DO UPDATE SET computed_at = now(), stop_set_hash = EXCLUDED.stop_set_hash, method = EXCLUDED.method, notice = EXCLUDED.notice`,
    [thursday, hash, method, fullNotice],
  );
  return { thursday, method, notice: fullNotice, recomputed: true };
}

/** What the sheet shows about the route, without calling Google. */
async function routeStatus(thursday, today = todayCentral()) {
  const [{ rows: [r] }, home, u, sheet] = await Promise.all([
    query('SELECT * FROM routes WHERE fulfillment_date = $1', [thursday]),
    settings.get('home_address', null),
    usage(today),
    buildSheet(thursday),
  ]);
  const driveStops = sheet.stops.filter((s) => s.kind === 'local_delivery' || s.kind === 'pickup');
  const current = r && r.stop_set_hash === hashStops(home, driveStops);
  return {
    home_address: home,
    method: r?.method || null,
    notice: r?.notice || null,
    computed_at: r?.computed_at || null,
    stale: !!r && !current,
    needs_compute: !r || !current,
    stop_count: driveStops.length,
    over_limit: driveStops.length > MAX_INTERMEDIATES,
    max_per_request: MAX_INTERMEDIATES,
    usage: u,
  };
}

/**
 * Re-plan from here (section 8): optimize only the stops still on Jay's
 * route (not delivered, not handed off), from the phone's location (or the
 * last delivered stop, or home) back home. Done and handed-off stops keep
 * their place first. One Google request, counted toward the daily cap.
 */
async function replanFromHere(thursday, position, o = {}) {
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const apiKey = o.apiKey ?? process.env.GOOGLE_ROUTES_API_KEY;
  const today = o.today || todayCentral();
  const home = await settings.get('home_address', null);
  if (!home) throw new Error('Set your home address first.');
  const pickupAddresses = await settings.get('pickup_addresses', {});
  const sheet = await buildSheet(thursday);
  const drive = sheet.stops
    .filter((s) => s.kind === 'local_delivery' || s.kind === 'pickup')
    .map((s) => ({ ...s, pickup_address: s.kind === 'pickup' ? pickupAddresses[s.label] : undefined }))
    .sort((a, b) => (a.route_position ?? 1e9) - (b.route_position ?? 1e9));
  const finished = drive.filter((s) => s.delivered_at || s.handed_off_at);
  const remaining = drive.filter((s) => !s.delivered_at && !s.handed_off_at);
  if (!remaining.length) return { thursday, replanned: 0, notice: 'Nothing left on your route.' };
  if (remaining.length > MAX_INTERMEDIATES) throw new Error(`${remaining.length} stops left is more than Google re-plans in one request (${MAX_INTERMEDIATES}).`);
  if (!apiKey) throw new Error('Route optimization is not set up (no Google key).');
  if ((await usage(today)).today + 1 > DAILY_CAP) throw new Error(`Daily limit of ${DAILY_CAP} route optimizations reached.`);

  let origin; let from;
  const lat = Number(position?.lat); const lng = Number(position?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    origin = { location: { latLng: { latitude: lat, longitude: lng } } }; from = 'your location';
  } else {
    const last = finished.filter((s) => s.delivered_at).sort((a, b) => new Date(b.delivered_at) - new Date(a.delivered_at))[0];
    if (last) { origin = { address: stopQuery(last) }; from = `your last stop (${last.label})`; } else { origin = { address: home }; from = 'home'; }
  }

  await countCall(today);
  const r = await optimizeOnce(fetchImpl, apiKey, home, remaining, origin);
  const order = [...finished, ...r.ordered];
  for (const [i, s] of order.entries()) {
    await query('UPDATE stops SET route_position = $3 WHERE fulfillment_date = $1 AND stop_key = $2', [thursday, s.stop_key, i + 1]);
    await query(
      `INSERT INTO stops (fulfillment_date, stop_key, kind, label, route_position) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (fulfillment_date, stop_key) DO NOTHING`,
      [thursday, s.stop_key, s.kind, s.label, i + 1],
    );
  }
  const at = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  const notice = `Re-planned ${remaining.length} stop${remaining.length === 1 ? '' : 's'} from ${from} at ${at}. About ${Math.round((parseInt(r.duration, 10) || 0) / 60)} min left.`;
  await query('UPDATE routes SET notice = $2, method = $3 WHERE fulfillment_date = $1', [thursday, notice, 'google']);
  return { thursday, replanned: remaining.length, from, notice };
}

module.exports = { computeRoute, routeStatus, replanFromHere, fallbackOrder, stopQuery, DAILY_CAP, MAX_INTERMEDIATES };
