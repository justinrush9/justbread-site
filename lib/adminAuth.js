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

// ── 30-day login cookie (SPEC.md section 8: a reload mid-route never asks
// for the password). Signed with a key derived from ADMIN_PASSWORD, so
// changing the password logs every device out. HttpOnly, so page scripts
// can't read it.
const COOKIE = 'jb_admin';
const SESSION_DAYS = 30;

function sessionKey() {
  return crypto.createHash('sha256').update(`jb-admin-session:${process.env.ADMIN_PASSWORD || ''}`).digest();
}

function sign(expires) {
  return crypto.createHmac('sha256', sessionKey()).update(String(expires)).digest('base64url');
}

function makeSessionCookie(now = Date.now()) {
  const expires = now + SESSION_DAYS * 86400e3;
  const value = `${expires}.${sign(expires)}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;
}

const clearSessionCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

function hasValidSession(req, now = Date.now()) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [expires, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!expires || !sig || Number(expires) < now) return false;
  return timingSafeStringEqual(sig, sign(expires));
}

function isAdminRequest(req) {
  if (hasValidSession(req)) return true;
  if (timingSafeStringEqual(req.headers['x-admin-password'], process.env.ADMIN_PASSWORD)) {
    return true;
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return timingSafeStringEqual(auth.slice(7), process.env.CRON_SECRET);
  }
  return false;
}

module.exports = { isAdminRequest, timingSafeStringEqual, makeSessionCookie, clearSessionCookie, hasValidSession };
