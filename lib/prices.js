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

// Reverse lookup: any local-delivery price ID -> true. Used by the webhook
// to classify an order as 'local' vs 'shipped' from its line items alone,
// without depending on metadata surviving onto every invoice.
const LOCAL_DELIVERY_PRICE_IDS = new Set([
  ...Object.values(PRICES.localSub),
  PRICES.localOnetime,
]);

const LOAF_PRICE_IDS = new Set(Object.values(PRICES.loaf));

module.exports = { PRICES, LOCAL_DELIVERY_PRICE_IDS, LOAF_PRICE_IDS };
