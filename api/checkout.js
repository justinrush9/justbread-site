/**
 * JustBread Checkout Backend
 * ==========================
 * Vercel serverless function — POST /api/checkout
 *
 * Takes a cart from the order page, validates the zone server-side,
 * builds a Stripe Checkout Session, and returns the session URL.
 * The browser then redirects the customer to Stripe Checkout.
 *
 * Request body (JSON):
 * {
 *   zip:       "60175",           // customer zip — re-validated here
 *   loaves:    2,                 // quantity (integer, 1–99)
 *   mode:      "sub" | "ot",      // subscription or one-time
 *   cadence:   "weekly" | "biweekly" | "monthly",  // ignored for mode=ot
 *   addons:    [],                // future: [{priceId, qty}] for seasonal specials
 * }
 *
 * Response:
 *   200 { url: "https://checkout.stripe.com/..." }
 *   400 { error: "..." }   validation failure
 *   500 { error: "..." }   Stripe error
 *
 * Environment variables (set in Vercel dashboard):
 *   STRIPE_SECRET_KEY          your sk_live_... key
 *   SUCCESS_URL                e.g. https://justbread.shop/order-confirmed
 *   CANCEL_URL                 e.g. https://justbread.shop/order
 *   ALLOWED_ORIGIN             https://justbread.shop  (CORS)
 */

const Stripe = require('stripe');

// ── PRICE IDs (from justbread_stripe.mjs list-build, live account) ────────────
const PRICES = {
  loaf: {
    onetime:  'price_1TgTWrJVnPyvSLMUoZrOGnXA',
    weekly:   'price_1TgTWrJVnPyvSLMUG2yl50f1',
    biweekly: 'price_1TgTWrJVnPyvSLMUyxTz6UQr',
    monthly:  'price_1TgTWrJVnPyvSLMUaUFP0ho9',
  },
  // Local delivery — flat fee. Subscriber cadences = $5, one-time = $7.
  localSub: {
    weekly:   'price_1TgVeQJVnPyvSLMUZ2n1yLax',
    biweekly: 'price_1TgVeRJVnPyvSLMUK0ukeVkj',
    monthly:  'price_1TgVeRJVnPyvSLMUFuohG0SJ',
  },
  localOnetime: 'price_1TgVeRJVnPyvSLMUK2e4GsPX',
};

// ── ZIP → ZONE (mirrors the front-end zip checker exactly) ────────────────────
const LOCAL_ZIPS = new Set(['60134', '60174', '60175', '60510']);

function getZone(zip) {
  if (!zip || !/^\d{5}$/.test(zip)) return null;
  if (LOCAL_ZIPS.has(zip)) return 'local';
  const prefix = parseInt(zip.slice(0, 2), 10);
  if (prefix >= 60 && prefix <= 62) return 'il';
  return null; // outside IL — reject
}

// ── IL SHIPPING (box-of-4 rule, mirrors justbread_stripe.mjs) ─────────────────
// Box of 4 ships for $9; partial box by count (1→$7, 2→$8, 3→$9).
// Single shipped loaf = $10 loaf + $7 = $17 delivered.
function computeShippingCents(loaves) {
  const FULL_BOX = 900;
  const PARTIAL  = { 1: 700, 2: 800, 3: 900 };
  if (loaves <= 0) return 0;
  const full = Math.floor(loaves / 4);
  const rem  = loaves % 4;
  return full * FULL_BOX + (rem ? PARTIAL[rem] : 0);
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS — only accept requests from the JustBread site
  const origin = process.env.ALLOWED_ORIGIN || 'https://justbread.shop';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Parse & validate ────────────────────────────────────────────
  const { zip, loaves, mode, cadence, addons = [] } = req.body || {};

  if (!zip || !loaves || !mode) {
    return res.status(400).json({ error: 'Missing required fields: zip, loaves, mode' });
  }

  const loavesInt = parseInt(loaves, 10);
  if (!Number.isInteger(loavesInt) || loavesInt < 1 || loavesInt > 99) {
    return res.status(400).json({ error: 'loaves must be an integer between 1 and 99' });
  }

  if (!['sub', 'ot'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "sub" or "ot"' });
  }

  const validCadences = ['weekly', 'biweekly', 'monthly'];
  if (mode === 'sub' && !validCadences.includes(cadence)) {
    return res.status(400).json({ error: 'cadence must be weekly, biweekly, or monthly for subscriptions' });
  }

  // ── Server-side zone validation (prevents zone-spoofing) ────────
  const zone = getZone(zip);
  if (!zone) {
    return res.status(400).json({ error: 'Sorry, we don\'t deliver to that ZIP code yet.' });
  }

  // ── Build Stripe line items ──────────────────────────────────────
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const isOT   = mode === 'ot';
  const key    = isOT ? 'onetime' : cadence; // price key

  const lineItems = [];

  // 1) Loaves — fixed price × quantity
  lineItems.push({
    price:    PRICES.loaf[key],
    quantity: loavesInt,
  });

  // 2) Delivery
  if (zone === 'local') {
    // Flat local fee: one-time uses the single $7 price, subs use the
    // cadence-matched $5 recurring price.
    lineItems.push({
      price:    isOT ? PRICES.localOnetime : PRICES.localSub[cadence],
      quantity: 1,
    });
  } else {
    // IL shipping — computed inline (no pre-created price needed)
    const shippingCents = computeShippingCents(loavesInt);
    const shippingLabel = `IL Shipping (${loavesInt} loaf${loavesInt > 1 ? 's' : ''})`;

    if (isOT) {
      lineItems.push({
        price_data: {
          currency:     'usd',
          unit_amount:  shippingCents,
          product_data: { name: shippingLabel },
        },
        quantity: 1,
      });
    } else {
      // Subscription mode: recurring inline price_data
      const cadenceMap = {
        weekly:   { interval: 'week',  interval_count: 1 },
        biweekly: { interval: 'week',  interval_count: 2 },
        monthly:  { interval: 'month', interval_count: 1 },
      };
      lineItems.push({
        price_data: {
          currency:   'usd',
          unit_amount: shippingCents,
          product_data: { name: shippingLabel },
          recurring:  cadenceMap[cadence],
        },
        quantity: 1,
      });
    }
  }

  // 3) Add-ons (seasonal specials, extra loaves, etc.)
  //    Each addon: { priceId: 'price_...', qty: 1 }
  for (const addon of addons) {
    if (addon.priceId && addon.qty > 0) {
      lineItems.push({ price: addon.priceId, quantity: parseInt(addon.qty, 10) });
    }
  }

  // ── Create Checkout Session ──────────────────────────────────────
  try {
    const sessionParams = {
      mode:         isOT ? 'payment' : 'subscription',
      line_items:   lineItems,
      success_url:  process.env.SUCCESS_URL || 'https://justbread.shop/order-confirmed?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:   process.env.CANCEL_URL  || 'https://justbread.shop/order',
      metadata: {
        zip,
        zone,
        loaves:  String(loavesInt),
        mode,
        cadence: cadence || 'onetime',
      },
    };

    // For one-time orders, use Stripe's real shipping_options (looks nicer in checkout)
    if (isOT) {
      sessionParams.shipping_address_collection = { allowed_countries: ['US'] };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: 'Unable to create checkout session. Please try again.' });
  }
};
