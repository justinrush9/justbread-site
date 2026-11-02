const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

// The live database was created from the Sep 2026 schema and has real rows.
// The new schema must upgrade it in place without losing or changing them.
test('schema upgrades the Sep 2026 orders table without losing rows', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE bakes (id SERIAL PRIMARY KEY, bake_date DATE NOT NULL, ship_date DATE, delivery_date DATE,
      status TEXT NOT NULL DEFAULT 'planned', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE orders (
      id SERIAL PRIMARY KEY, stripe_event_id TEXT UNIQUE NOT NULL, stripe_customer_id TEXT NOT NULL,
      stripe_subscription_id TEXT, customer_email TEXT, customer_name TEXT, loaves INTEGER NOT NULL,
      fulfillment_type TEXT NOT NULL, order_type TEXT NOT NULL, cadence TEXT,
      status TEXT NOT NULL DEFAULT 'ordered', bake_id INTEGER REFERENCES bakes(id), raw_metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO orders (stripe_event_id, stripe_customer_id, loaves, fulfillment_type, order_type, raw_metadata)
    VALUES ('evt_old1', 'cus_old', 2, 'local', 'subscription', '{"zip":"60134"}'),
           ('evt_old2', 'cus_old2', 1, 'shipped', 'onetime', '{"delivery_code":"ECB","delivery_override":"Energy City Brewing — Batavia"}');
  `);
  const schema = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');
  await db.exec(schema);
  await db.exec(schema);
  const rows = (await db.query('SELECT stripe_event_id, delivery_method, pickup_location, payment_status, source FROM orders ORDER BY id')).rows;
  assert.deepEqual(rows, [
    { stripe_event_id: 'evt_old1', delivery_method: 'local_delivery', pickup_location: null, payment_status: 'paid', source: 'stripe' },
    { stripe_event_id: 'evt_old2', delivery_method: 'pickup', pickup_location: 'Energy City Brewing — Batavia', payment_status: 'paid', source: 'stripe' },
  ]);
  // Manual orders (no Stripe ids) must now be insertable.
  await db.query(`INSERT INTO orders (source, loaves, fulfillment_type, order_type, payment_status) VALUES ('manual', 1, 'local', 'manual', 'unpaid')`);
});
