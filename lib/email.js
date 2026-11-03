/**
 * Every email the site sends goes through sendEmail() (SPEC.md 9c, 9d).
 *
 * Safeguards, all enforced here:
 *   - Never twice: each email has a dedupe key, reserved in emails_sent
 *     before sending, so a webhook resend or a double tap can't repeat it.
 *   - Customer emails are held until Jay switches them on (setting
 *     customer_emails_enabled), after he has approved the wording.
 *   - Outside production (Vercel previews, local) customer emails go to
 *     info@justbread.shop instead, marked TEST. The preview database is a
 *     copy of the real one, so it holds real customers' addresses.
 *   - Delivered / Shipped emails respect the customer's opt-out.
 *   - A failed send never throws into the caller; it is recorded and the
 *     daily cron retries it (up to 3 attempts).
 */

const crypto = require('crypto');
const { query } = require('../db/client');
const settings = require('./settings');

const FROM = 'Just Bread <orders@justbread.shop>';
const REPLY_TO = 'info@justbread.shop';
const RESEND_URL = 'https://api.resend.com/emails';
const MAX_ATTEMPTS = 3;

const isProduction = () => process.env.VERCEL_ENV === 'production';

function siteUrl() {
  if (isProduction()) return 'https://www.justbread.shop';
  if (process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:4321';
}

async function alertAddress() {
  return settings.get('alert_email', REPLY_TO);
}

async function customerEmailsEnabled() {
  return (await settings.get('customer_emails_enabled', false)) === true;
}

// ── one-click opt-out links ──────────────────────────────────────────────
async function linkSecret() {
  let s = await settings.get('link_secret', null);
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await settings.set('link_secret', s); }
  return s;
}

async function optOutLink(email) {
  const e = String(email).toLowerCase();
  const sig = crypto.createHmac('sha256', await linkSecret()).update(e).digest('base64url');
  return `${siteUrl()}/api/email-prefs?e=${encodeURIComponent(e)}&s=${sig}`;
}

async function verifyOptOut(email, sig) {
  const e = String(email || '').toLowerCase();
  if (!e || !sig) return false;
  const expected = crypto.createHmac('sha256', await linkSecret()).update(e).digest('base64url');
  const a = Buffer.from(String(sig)); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function deliveryEmailsAllowed(email) {
  const { rows: [r] } = await query('SELECT delivery_emails FROM customer_email_prefs WHERE email = $1', [String(email).toLowerCase()]);
  return r ? r.delivery_emails : true;
}

async function setDeliveryEmails(email, on) {
  await query(
    `INSERT INTO customer_email_prefs (email, delivery_emails, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (email) DO UPDATE SET delivery_emails = EXCLUDED.delivery_emails, updated_at = now()`,
    [String(email).toLowerCase(), !!on],
  );
}

// ── sending ──────────────────────────────────────────────────────────────
async function deliver(fetchImpl, { to, subject, html, text, headers }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const res = await fetchImpl(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html, text, headers }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Resend returned ${res.status}`);
  return data.id || null;
}

/**
 * @param {object} m
 *   type        'alert' | 'confirmation' | 'delivered' | 'shipped' | 'change' | 'broadcast'
 *   dedupeKey   unique per real-world email
 *   to          recipient (the customer, or Jay for alerts)
 *   customer    true for anything sent to a customer
 *   subject, html, text, orderId, subscriptionId, broadcastId
 * @returns {{status: 'sent'|'failed'|'held'|'duplicate'|'opted_out'}}
 */
async function sendEmail(m, { fetchImpl = globalThis.fetch } = {}) {
  if (!m.to) return { status: 'skipped', reason: 'no address' };
  let to = m.to; let subject = m.subject; const headers = {};

  if (m.customer) {
    if (['delivered', 'shipped'].includes(m.type) && !(await deliveryEmailsAllowed(m.to))) return { status: 'opted_out' };
    if (['delivered', 'shipped'].includes(m.type)) {
      const link = await optOutLink(m.to);
      headers['List-Unsubscribe'] = `<${link}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    if (!isProduction()) { subject = `[TEST to ${m.to}] ${subject}`; to = await alertAddress(); }
  }

  // Jay-written notices (m.approved) are approved by definition; automatic
  // customer emails wait for the switch.
  const held = m.customer && !m.approved && !(await customerEmailsEnabled());
  const reserve = await query(
    `INSERT INTO emails_sent (email_type, dedupe_key, recipient, order_id, stripe_subscription_id, broadcast_id, status, subject, html, text_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [m.type, m.dedupeKey, to, m.orderId || null, m.subscriptionId || null, m.broadcastId || null,
     held ? 'held' : 'pending', subject, m.html || null, m.text || null],
  );
  if (!reserve.rowCount) return { status: 'duplicate' };
  const id = reserve.rows[0].id;
  if (held) return { status: 'held' };

  try {
    const providerId = await deliver(fetchImpl, { to, subject, html: m.html, text: m.text, headers });
    await query(`UPDATE emails_sent SET status = 'sent', provider_message_id = $2, sent_at = now() WHERE id = $1`, [id, providerId]);
    return { status: 'sent' };
  } catch (err) {
    console.error(`email ${m.dedupeKey} failed:`, err.message);
    await query(`UPDATE emails_sent SET status = 'failed', last_error = $2 WHERE id = $1`, [id, err.message.slice(0, 500)]);
    return { status: 'failed', error: err.message };
  }
}

/** Daily cron: retry failed sends, at most MAX_ATTEMPTS each. */
async function retryFailed({ fetchImpl = globalThis.fetch } = {}) {
  const { rows } = await query(
    `SELECT * FROM emails_sent WHERE status = 'failed' AND attempts < $1 AND sent_at > now() - INTERVAL '3 days' ORDER BY id LIMIT 50`,
    [MAX_ATTEMPTS],
  );
  let sent = 0;
  for (const r of rows) {
    try {
      const providerId = await deliver(fetchImpl, { to: r.recipient, subject: r.subject, html: r.html, text: r.text_body });
      await query(`UPDATE emails_sent SET status = 'sent', provider_message_id = $2, attempts = attempts + 1, sent_at = now() WHERE id = $1`, [r.id, providerId]);
      sent += 1;
    } catch (err) {
      await query(`UPDATE emails_sent SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [r.id, err.message.slice(0, 500)]);
    }
  }
  return { retried: rows.length, sent };
}

module.exports = {
  sendEmail, retryFailed, optOutLink, verifyOptOut, setDeliveryEmails, deliveryEmailsAllowed,
  alertAddress, customerEmailsEnabled, siteUrl, FROM, REPLY_TO,
};
