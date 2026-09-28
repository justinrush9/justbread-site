/**
 * Shared auth for internal, non-Stripe admin endpoints (api/orders.js,
 * api/reconcile.js). Two accepted credentials:
 *   - x-admin-password header, checked against ADMIN_PASSWORD — what the
 *     /admin dashboard sends.
 *   - Authorization: Bearer <CRON_SECRET> — how Vercel Cron calls
 *     /api/reconcile automatically. Set CRON_SECRET in Vercel env vars;
 *     Vercel sends it as this header on cron-triggered requests once it's
 *     set, no extra config needed.
 * Low-value internal tooling for a solo operator, not a customer-facing
 * surface, so a shared secret per credential is proportionate.
 */

const crypto = require('crypto');

function timingSafeStringEqual(candidate, expected) {
  if (!expected || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAdminRequest(req) {
  if (timingSafeStringEqual(req.headers['x-admin-password'], process.env.ADMIN_PASSWORD)) {
    return true;
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return timingSafeStringEqual(auth.slice(7), process.env.CRON_SECRET);
  }
  return false;
}

module.exports = { isAdminRequest, timingSafeStringEqual };
