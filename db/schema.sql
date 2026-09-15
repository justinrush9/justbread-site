-- JustBread order management schema
-- Postgres. Run once against whatever DATABASE_URL points to.

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
