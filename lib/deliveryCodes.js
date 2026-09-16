/**
 * Speakeasy delivery codes.
 *
 * Not Stripe promotion codes — these are checked server-side only, against
 * this fixed list, so they're never enumerable via the Stripe API and never
 * appear as a discoverable "enter a coupon" affordance. A valid code:
 *   - waives the local delivery fee (loaves stay $10 each)
 *   - forces zone = 'local' regardless of the customer's own ZIP, since the
 *     order actually goes to a fixed drop point, not the customer's address
 *
 * To add a new one: pick an all-caps code, add an entry below, tell the
 * person the code out loud. Nothing here is customer-facing.
 */

const DELIVERY_CODES = {
  RGD: {
    label: 'Rush Group Detailing — St. Charles',
  },
  HHS: {
    label: 'Hoffman Estates Health & Human Services (via Sharon)',
  },
  ECB: {
    label: 'Energy City Brewing — Batavia',
  },
  CMFLORALS: {
    label: 'CM Florals — St. Charles',
  },
};

function lookupDeliveryCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return DELIVERY_CODES[code] ? { code, ...DELIVERY_CODES[code] } : null;
}

module.exports = { DELIVERY_CODES, lookupDeliveryCode };
