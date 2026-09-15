/**
 * Shared Stripe price catalog for JustBread.
 * Single source of truth — checkout.js and api/webhook.js both require this
 * instead of keeping their own copies, so a price ID only ever needs updating
 * in one place.
 */

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

// Pre-restructure subscription prices still active on grandfathered
// subscribers (never touched in Stripe itself, per the additive-only
// safety contract — recognized here purely so the webhook can still
// count their loaves and fulfillment type).
//
// loavesPerUnit is normally 1 (Stripe quantity does the counting), except
// price_1OtXyoJVnPyvSLMUK1jhbHqU ("Every-Other-Week Subscription", $35/mo):
// Stripe quantity is always 1, but each monthly invoice actually covers 2
// loaves (one every other week). Which specific week is each customer's
// "on" week varies per subscriber and can't be derived from the invoice —
// that's a separate problem for whenever bake-to-order linking gets built.
//
// Reviewed and intentionally excluded: price_1UAUwjJVnPyvSLMUKn8KCgEo and
// price_1TzhlOJVnPyvSLMUX06shu8u are legacy IL-shipping *fee* lines (not
// loaves) that ride alongside an already-recognized loaf price line on the
// same subscription — adding them here would double-count.
const LEGACY_LOAF_PRICES = {
  'price_1NQadSJVnPyvSLMUQDvQsybQ': { loavesPerUnit: 1, local: true },  // Single Loaf Weekly Subscription — local, all-inclusive $15
  'price_1OtXyoJVnPyvSLMUK1jhbHqU': { loavesPerUnit: 2, local: true },  // Every-Other-Week Subscription — $35/mo, local
  'price_1RksNMJVnPyvSLMUp3FRA3pF': { loavesPerUnit: 1, local: false }, // ECB - Weekly Subscription
  'price_1RksRNJVnPyvSLMUKchE3qUl': { loavesPerUnit: 1, local: false }, // ECB - Every-Other-Week
  'price_1Oa36FJVnPyvSLMUTUWpz5W4': { loavesPerUnit: 1, local: false }, // Single Loaf Weekly Subscription - Shipped
};

// Reverse lookup: any local-delivery price ID -> true. Used by the webhook
// to classify an order as 'local' vs 'shipped' from its line items alone,
// without depending on metadata surviving onto every invoice.
const LOCAL_DELIVERY_PRICE_IDS = new Set([
  ...Object.values(PRICES.localSub),
  PRICES.localOnetime,
  ...Object.entries(LEGACY_LOAF_PRICES).filter(([, cfg]) => cfg.local).map(([id]) => id),
]);

// price ID -> loaves per unit of Stripe quantity. Used by the webhook to
// count loaves on any line item, current-catalog or legacy.
const LOAF_PRICE_IDS = new Map([
  ...Object.values(PRICES.loaf).map((id) => [id, 1]),
  ...Object.entries(LEGACY_LOAF_PRICES).map(([id, cfg]) => [id, cfg.loavesPerUnit]),
]);

module.exports = { PRICES, LOCAL_DELIVERY_PRICE_IDS, LOAF_PRICE_IDS };
