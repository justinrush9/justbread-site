const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('../helpers/db');
const route = require('../../lib/route');
const settings = require('../../lib/settings');
const { setDelivered } = require('../../lib/sheet');

const T = '2026-11-12';
const TODAY = '2026-11-12';
async function seed(db, n = 3) {
  const addrs = [['827 May St', '60134'], ['1606 Bentz Way', '60510'], ['128 S 6th St', '60134'], ['4N160 Burr Road', '60175']];
  for (let i = 0; i < n; i++) {
    const [line1, zip] = addrs[i % addrs.length];
    await db.query(
      `INSERT INTO orders (source, order_type, payment_status, customer_name, loaves, fulfillment_type, delivery_method, shipping_address, fulfillment_date)
       VALUES ('stripe','subscription','paid',$1,1,'local','local_delivery',$2,$3)`,
      [`C${i}`, JSON.stringify({ line1: i < 4 ? line1 : `${i} Test St`, city: 'X', state: 'IL', postal_code: zip }), T],
    );
  }
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_name, loaves, fulfillment_type, delivery_method, pickup_location, fulfillment_date)
                  VALUES ('stripe','onetime','paid','P',2,'local','pickup','Energy City Brewing — Batavia',$1)`, [T]);
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_name, loaves, fulfillment_type, delivery_method, shipping_address, fulfillment_date)
                  VALUES ('stripe','onetime','paid','S',1,'shipped','shipped','{"line1":"1 A","postal_code":"60513"}',$1)`, [T]);
}

function fakeGoogle(reverse = true) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const n = body.intermediates.length;
    const order = [...Array(n).keys()];
    if (reverse) order.reverse();
    return { ok: true, json: async () => ({ routes: [{ optimizedIntermediateWaypointIndex: order, duration: '1800s', distanceMeters: 16093 }] }) };
  };
  return { calls, fetchImpl };
}

const positions = async (db) => (await db.query('SELECT stop_key, route_position FROM stops WHERE fulfillment_date=$1 ORDER BY route_position', [T])).rows;

test('optimizes once, from home to home, through local stops and pickup points but not UPS', async () => {
  const db = await freshDb();
  await seed(db);
  await settings.set('home_address', '1 Home Rd, Geneva, IL 60134');
  const g = fakeGoogle();
  const r = await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  assert.equal(r.method, 'google');
  assert.equal(g.calls.length, 1);
  const b = g.calls[0].body;
  assert.equal(b.origin.address, '1 Home Rd, Geneva, IL 60134');
  assert.equal(b.destination.address, b.origin.address);
  assert.equal(b.optimizeWaypointOrder, true);
  assert.equal(b.intermediates.length, 4, '3 houses + 1 pickup point, no shipping stop');
  assert.ok(!b.intermediates.some((i) => /1 A/.test(i.address)));
  assert.equal(g.calls[0].headers['X-Goog-Api-Key'], 'k');
  assert.match(r.notice, /About 30 min, 10 mi/);
  assert.equal((await positions(db)).length, 4);

  // Unchanged stops: no second call, even if asked to "optimize" again.
  await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  assert.equal(g.calls.length, 1);
  // Re-optimize forces a call.
  await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY, force: true });
  assert.equal(g.calls.length, 2);
  // A ticked stop keeps its tick through a recompute.
  const first = (await positions(db))[0];
  await setDelivered(T, first.stop_key, true);
  await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY, force: true });
  assert.ok((await db.query('SELECT delivered_at FROM stops WHERE stop_key=$1', [first.stop_key])).rows[0].delivered_at);
});

test('a new stop makes the stored route stale and triggers one recompute', async () => {
  const db = await freshDb();
  await seed(db, 2);
  await settings.set('home_address', '1 Home Rd, Geneva, IL 60134');
  const g = fakeGoogle();
  await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  assert.equal((await route.routeStatus(T, TODAY)).needs_compute, false);
  await db.query(`INSERT INTO orders (source, order_type, payment_status, customer_name, loaves, fulfillment_type, delivery_method, shipping_address, fulfillment_date)
                  VALUES ('manual','manual','unpaid','New',1,'local','local_delivery','{"line1":"9 New St","postal_code":"60174"}',$1)`, [T]);
  const st = await route.routeStatus(T, TODAY);
  assert.equal(st.stale, true);
  await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  assert.equal(g.calls.length, 2);
});

test('falls back to ZIP order with a notice: no home, no key, Google error, daily cap', async () => {
  const db = await freshDb();
  await seed(db);
  const g = fakeGoogle();
  let r = await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  assert.equal(r.method, 'fallback'); assert.match(r.notice, /home address/); assert.equal(g.calls.length, 0);

  await settings.set('home_address', '1 Home Rd, Geneva, IL 60134');
  r = await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: '', today: TODAY, force: true });
  assert.match(r.notice, /no Google key/);

  const failing = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) });
  r = await route.computeRoute(T, { fetchImpl: failing, apiKey: 'k', today: TODAY, force: true });
  assert.equal(r.method, 'fallback'); assert.match(r.notice, /API key not valid/);
  const zips = (await db.query(`SELECT s.stop_key FROM stops s WHERE fulfillment_date=$1 AND kind='local_delivery' ORDER BY route_position`, [T])).rows.map((x) => x.stop_key.split('|')[1]);
  assert.deepEqual(zips, [...zips].sort(), 'ZIP order');

  await db.query(`INSERT INTO api_usage (day, service, count) VALUES ($1, 'google_routes', $2)
                  ON CONFLICT (day, service) DO UPDATE SET count = EXCLUDED.count`, [TODAY, route.DAILY_CAP]);
  r = await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY, force: true });
  assert.match(r.notice, /Daily limit of 150/);
  assert.equal(g.calls.length, 0, 'never calls Google past the cap');
  const u = (await route.routeStatus(T, TODAY)).usage;
  assert.equal(u.today, 150);
});

test('more stops than one request allows: optimized in two halves, warned in advance', async () => {
  const db = await freshDb();
  await seed(db, 30);
  await settings.set('home_address', '1 Home Rd, Geneva, IL 60134');
  // 26 unique addresses from the generated ones + 4 repeats merge into stops
  const st = await route.routeStatus(T, TODAY);
  assert.equal(st.over_limit, st.stop_count > route.MAX_INTERMEDIATES);
  const g = fakeGoogle();
  const r = await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  if (st.over_limit) {
    assert.equal(g.calls.length, 2);
    assert.match(r.notice, /two halves/);
  }
  assert.equal((await positions(db)).length, st.stop_count);
});

test('hand off: off the route, no email; re-plan from the phone covers only what is left', async () => {
  const db = await freshDb();
  await seed(db, 4);
  await settings.set('home_address', '1 Home Rd, Geneva, IL 60134');
  const g = fakeGoogle(false);
  await route.computeRoute(T, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  const { setHandedOff, buildSheet } = require('../../lib/sheet');
  let stops = (await db.query('SELECT stop_key FROM stops WHERE fulfillment_date=$1 ORDER BY route_position', [T])).rows.map((r) => r.stop_key);
  await setDelivered(T, stops[0], true);
  await setHandedOff(T, stops[1], true);
  await setHandedOff(T, stops[2], true);
  const sheet = await buildSheet(T);
  assert.equal(sheet.summary.stops_with_helper, 2);
  const emailsSent = (await db.query(`SELECT count(*)::int AS n FROM emails_sent WHERE email_type='delivered'`)).rows[0].n;

  const r = await route.replanFromHere(T, { lat: 41.88, lng: -88.31 }, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  assert.equal(r.replanned, 2, '5 stops - 1 delivered - 2 with helper');
  const call = g.calls.at(-1).body;
  assert.deepEqual(call.origin, { location: { latLng: { latitude: 41.88, longitude: -88.31 } } });
  assert.equal(call.destination.address, '1 Home Rd, Geneva, IL 60134');
  assert.equal(call.intermediates.length, 2);
  const after = (await db.query('SELECT stop_key FROM stops WHERE fulfillment_date=$1 ORDER BY route_position', [T])).rows.map((x) => x.stop_key);
  assert.deepEqual(after.slice(0, 3), stops.slice(0, 3), 'done and handed-off stops stay first');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM emails_sent WHERE email_type='delivered'`)).rows[0].n, emailsSent, 'hand-off sends no email');

  // No location: starts from the last delivered stop.
  await route.replanFromHere(T, null, { fetchImpl: g.fetchImpl, apiKey: 'k', today: TODAY });
  assert.ok(g.calls.at(-1).body.origin.address, 'address origin');
  assert.notEqual(g.calls.at(-1).body.origin.address, '1 Home Rd, Geneva, IL 60134');
  // The stored route stays valid: no automatic recompute was triggered by hand-offs.
  assert.equal((await route.routeStatus(T, TODAY)).needs_compute, false);
});
