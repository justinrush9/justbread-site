/**
 * Retired Nov 13 2026. This endpoint opened any customer's Stripe billing
 * portal from an email address alone, with no proof the caller owned that
 * email. /manage uses Stripe's own portal login (email + one-time code)
 * instead, so nothing calls this anymore.
 */
module.exports = function handler(req, res) {
  res.status(410).json({ error: 'Gone. Manage your subscription at https://justbread.shop/manage/' });
};
