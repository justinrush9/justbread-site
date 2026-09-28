-- JustBread order management schema
-- Postgres. Safe to run against a fresh DB or an existing one — every
-- statement is idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS), so re-running this file after a migration is added is the normal
-- way to bring a database up to date.

CREATE TABLE IF NOT EXISTS bakes (
  id             SERIAL PRIMARY KEY,
  bake_date      DATE NOT NULL,
  ship_date      DATE,             -- IL shipping orders go out this day (Wed)
  delivery_date  DATE,             -- local delivery day (Fri) / shipped arrival (Thu)
  status         TEXT NOT NULL DEFAULT 'planned',  -- planned -> baking -> baked -> complete
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                  SERIAL PRIMARY KEY,
  stripe_event_id     TEXT UNIQUE NOT NULL,   -- idempotency guard against Stripe retries
  stripe_customer_id  TEXT NOT NULL,
  stripe_subscription_id TEXT,                -- null for one-time orders
  customer_email      TEXT,
  customer_name       TEXT,
  loaves              INTEGER NOT NULL,
  fulfillment_type    TEXT NOT NULL,          -- 'local' | 'shipped'
  order_type          TEXT NOT NULL,          -- 'onetime' | 'subscription'
  cadence             TEXT,                   -- 'weekly' | 'biweekly' | 'monthly' | null
  status              TEXT NOT NULL DEFAULT 'ordered',
                      -- ordered -> baking -> baked -> out_for_delivery/shipped -> delivered
  bake_id             INTEGER REFERENCES bakes(id),
  raw_metadata        JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_bake_id ON orders(bake_id);

-- ── Migration: delivery mechanic + fulfillment date (Sep 2026) ─────────────
-- fulfillment_type ('local'/'shipped') only ever said whether a delivery fee
-- was charged — it couldn't distinguish a driveway drop from a business
-- pickup point, and it carried no address or bake-week assignment. These
-- columns make that queryable instead of living only in raw_metadata.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'shipped';
  -- 'pickup' | 'local_delivery' | 'shipped' — see lib/orderProcessing.js classifyDelivery()
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_location TEXT;
  -- drop-point label (e.g. "Energy City Brewing — Batavia"), set only when delivery_method = 'pickup'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address JSONB;
  -- set for 'local_delivery' and 'shipped'; null for 'pickup' (goes to a fixed drop point, not the customer's address)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_date DATE;
  -- which bake week this order is assigned to — see lib/fulfillment.js for the Tuesday-noon cutoff rule

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_date ON orders(fulfillment_date);

-- Backfill existing rows from what's already sitting in raw_metadata, so
-- history isn't lost. Safe to re-run: only touches rows still at the
-- 'shipped' default that the backfill itself would actually change.
-- fulfillment_date is intentionally NOT backfilled here — computing it
-- retroactively from `created_at` would misrepresent orders that were
-- placed, and fulfilled, before this cutoff rule existed.
UPDATE orders
SET delivery_method = CASE
      WHEN raw_metadata->>'delivery_code' IS NOT NULL THEN 'pickup'
      WHEN fulfillment_type = 'local' THEN 'local_delivery'
      ELSE 'shipped'
    END,
    pickup_location = raw_metadata->>'delivery_override'
WHERE delivery_method = 'shipped'
  AND (raw_metadata->>'delivery_code' IS NOT NULL OR fulfillment_type = 'local');
