-- JustBread order management schema (SPEC.md section 12)
-- Postgres. Idempotent: every statement is CREATE ... IF NOT EXISTS or
-- ADD COLUMN IF NOT EXISTS, so running this file again is the normal way to
-- bring any database (fresh, or the existing one with old rows) up to date.

-- ── Legacy tables ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bakes (
  id             SERIAL PRIMARY KEY,
  bake_date      DATE NOT NULL,
  ship_date      DATE,
  delivery_date  DATE,
  status         TEXT NOT NULL DEFAULT 'planned',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                  SERIAL PRIMARY KEY,
  stripe_event_id     TEXT UNIQUE,
  stripe_customer_id  TEXT,
  stripe_subscription_id TEXT,                -- null for one-time orders
  customer_email      TEXT,
  customer_name       TEXT,
  loaves              INTEGER NOT NULL,
  fulfillment_type    TEXT NOT NULL,          -- 'local' | 'shipped'
  order_type          TEXT NOT NULL,          -- 'onetime' | 'subscription' | 'manual' | 'standing'
  cadence             TEXT,                   -- 'weekly' | 'biweekly' | 'monthly' | null
  status              TEXT NOT NULL DEFAULT 'ordered',
  bake_id             INTEGER REFERENCES bakes(id),
  raw_metadata        JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_bake_id ON orders(bake_id);

-- Manual and standing orders have no Stripe event or customer (section 6).
ALTER TABLE orders ALTER COLUMN stripe_event_id DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN stripe_customer_id DROP NOT NULL;

-- ── Delivery mechanic + fulfillment date (Sep 2026) ────────────────────────

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'shipped';
  -- 'pickup' | 'local_delivery' | 'shipped'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_location TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_date DATE;
  -- the Thursday this order is delivered (lib/fulfillment.js). Set once, never recalculated.

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_date ON orders(fulfillment_date);

-- ── Section 12: orders additions ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS standing_orders (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  loaves           INTEGER NOT NULL CHECK (loaves > 0),
  delivery_method  TEXT NOT NULL,            -- 'pickup' | 'local_delivery' | 'shipped'
  address          JSONB,
  pickup_location  TEXT,
  frequency        TEXT NOT NULL,            -- 'weekly' | 'biweekly'
  start_date       DATE NOT NULL,            -- a Thursday; every-other-week alternates from here
  end_date         DATE,
  paused           BOOLEAN NOT NULL DEFAULT false,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'stripe';
  -- 'stripe' | 'manual' | 'standing'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid';
  -- 'paid' | 'declined' | 'refunded' | 'unpaid' (manual) | 'n/a' (barter)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_cents INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS declined_resolved_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stop_key TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS standing_order_id INTEGER REFERENCES standing_orders(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_stripe_invoice
  ON orders(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_payment_intent ON orders(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_orders_subscription ON orders(stripe_subscription_id);

-- ── Section 12: new tables ─────────────────────────────────────────────────

-- Mirror of Stripe subscriptions. Written only from Stripe events and the
-- daily refresh; the app's own Stripe writes (core rule 9) come back here
-- through those same events.
CREATE TABLE IF NOT EXISTS subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  stripe_customer_id     TEXT,
  customer_name          TEXT,
  customer_email         TEXT,
  customer_phone         TEXT,
  cadence                TEXT,
  loaves                 INTEGER,
  delivery_method        TEXT,
  pickup_location        TEXT,
  shipping_address       JSONB,
  status                 TEXT NOT NULL,      -- Stripe status; 'trialing' counts as active
  next_renewal_at        TIMESTAMPTZ,
  pause_resumes_at       TIMESTAMPTZ,
  paused                 BOOLEAN NOT NULL DEFAULT false,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  cancel_at              TIMESTAMPTZ,
  ended_at               TIMESTAMPTZ,
  ended_reason           TEXT,               -- 'customer' | 'failed_payment' | 'jay'
  cancellation_comment   TEXT,
  stripe_event_created   BIGINT NOT NULL DEFAULT 0, -- newest event applied; older replays are ignored
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_renewal ON subscriptions(next_renewal_at);

CREATE TABLE IF NOT EXISTS standing_order_occurrences (
  id                 SERIAL PRIMARY KEY,
  standing_order_id  INTEGER NOT NULL REFERENCES standing_orders(id),
  fulfillment_date   DATE NOT NULL,
  state              TEXT NOT NULL,          -- 'skipped' | 'delivered' | 'frozen'
  loaves             INTEGER,
  delivery_method    TEXT,
  address            JSONB,
  pickup_location    TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (standing_order_id, fulfillment_date)
);

CREATE TABLE IF NOT EXISTS stops (
  id                SERIAL PRIMARY KEY,
  fulfillment_date  DATE NOT NULL,
  stop_key          TEXT NOT NULL,           -- normalized address | 'pickup:<name>' | 'shipping'
  kind              TEXT NOT NULL,           -- 'local_delivery' | 'pickup' | 'shipping'
  label             TEXT,
  route_position    INTEGER,
  delivered_at      TIMESTAMPTZ,
  UNIQUE (fulfillment_date, stop_key)
);

CREATE TABLE IF NOT EXISTS routes (
  fulfillment_date  DATE PRIMARY KEY,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  stop_set_hash     TEXT NOT NULL,
  method            TEXT NOT NULL,           -- 'google' | 'fallback'
  notice            TEXT
);

CREATE TABLE IF NOT EXISTS production_starts (
  id                SERIAL PRIMARY KEY,
  fulfillment_date  DATE NOT NULL,
  step              TEXT NOT NULL,           -- e.g. 'starter_am', 'starter_pm', 'mix'
  loaves            INTEGER NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fulfillment_date, step)
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS week_overrides (
  fulfillment_date     DATE PRIMARY KEY,
  extras_override      INTEGER,
  start_time_override  TEXT                  -- 'HH:MM', Central
);

CREATE TABLE IF NOT EXISTS alerts (
  id                      SERIAL PRIMARY KEY,
  stripe_event_id         TEXT UNIQUE,       -- blocks duplicates when Stripe resends
  type                    TEXT NOT NULL,
  stripe_subscription_id  TEXT,
  message                 TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts(created_at) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  endpoint    TEXT UNIQUE NOT NULL,
  keys        JSONB NOT NULL,
  device      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_usage (
  day      DATE NOT NULL,
  service  TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, service)
);

CREATE TABLE IF NOT EXISTS customer_email_prefs (
  email            TEXT PRIMARY KEY,         -- lowercased
  delivery_emails  BOOLEAN NOT NULL DEFAULT true,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id                SERIAL PRIMARY KEY,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  recipients_count  INTEGER,
  pause_until       DATE,
  sent_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS emails_sent (
  id                   SERIAL PRIMARY KEY,
  email_type           TEXT NOT NULL,        -- 'confirmation' | 'delivered' | 'shipped' | 'change' | 'broadcast'
  dedupe_key           TEXT UNIQUE NOT NULL, -- e.g. 'delivered:order:123', 'change:evt_...'
  recipient            TEXT NOT NULL,
  order_id             INTEGER REFERENCES orders(id),
  stripe_subscription_id TEXT,
  broadcast_id         INTEGER REFERENCES broadcasts(id),
  status               TEXT NOT NULL,        -- 'sent' | 'failed'
  provider_message_id  TEXT,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Backfill for rows written before Sep 28 2026 ───────────────────────────
UPDATE orders
SET delivery_method = CASE
      WHEN raw_metadata->>'delivery_code' IS NOT NULL THEN 'pickup'
      WHEN fulfillment_type = 'local' THEN 'local_delivery'
      ELSE 'shipped'
    END,
    pickup_location = raw_metadata->>'delivery_override'
WHERE delivery_method = 'shipped'
  AND (raw_metadata->>'delivery_code' IS NOT NULL OR fulfillment_type = 'local');

-- ── Phase 7: email retries and settings for alerts ─────────────────────────
ALTER TABLE emails_sent ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE emails_sent ADD COLUMN IF NOT EXISTS html TEXT;
ALTER TABLE emails_sent ADD COLUMN IF NOT EXISTS text_body TEXT;
ALTER TABLE emails_sent ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE emails_sent ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMPTZ;

-- ── Helper hand-off (section 8) ────────────────────────────────────────────
ALTER TABLE stops ADD COLUMN IF NOT EXISTS handed_off_at TIMESTAMPTZ;

-- ── Moving a week's delivery day (section 7f) ──────────────────────────────
ALTER TABLE week_overrides ADD COLUMN IF NOT EXISTS delivery_date DATE;

-- ── How did you hear about us (section 9e) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_sources (
  stripe_session_id  TEXT PRIMARY KEY,
  customer_email     TEXT,
  source             TEXT NOT NULL,
  other_text         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
