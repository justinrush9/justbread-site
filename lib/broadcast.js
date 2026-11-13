/**
 * Notice to all subscribers (SPEC.md 9d), written by Jay, optionally pausing
 * every active subscription until a Thursday at the same time (6d controls).
 */

const { query } = require('../db/client');
const { sendEmail, alertAddress } = require('./email');
const tpl = require('./emailTemplates');

async function recipients() {
  const { rows } = await query(
    `SELECT DISTINCT ON (lower(customer_email)) stripe_subscription_id, customer_email, customer_name
     FROM subscriptions
     WHERE status IN ('active', 'trialing', 'past_due') AND customer_email IS NOT NULL
     ORDER BY lower(customer_email), updated_at DESC`,
  );
  return rows;
}

async function sendTest(subject, body) {
  const to = await alertAddress();
  const t = tpl.broadcast(`[TEST] ${subject}`, body, 'Justin');
  return sendEmail({ type: 'broadcast', dedupeKey: `broadcast-test:${Date.now()}`, to, customer: false, ...t });
}

async function sendBroadcast({ subject, body, pauseUntil }, { stripe, skipUntil } = {}) {
  if (!subject || !body) throw new Error('Subject and message are both needed.');
  const list = await recipients();
  const { rows: [b] } = await query(
    `INSERT INTO broadcasts (subject, body, recipients_count, pause_until, sent_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [subject, body, list.length, pauseUntil || null],
  );
  const result = { broadcast_id: b.id, recipients: list.length, sent: 0, held: 0, failed: 0, paused: 0, pause_errors: [] };
  for (const r of list) {
    if (pauseUntil) {
      try { await skipUntil(stripe, r.stripe_subscription_id, pauseUntil); result.paused += 1; } catch (err) { result.pause_errors.push({ name: r.customer_name || r.customer_email, error: err.message }); }
    }
    const s = await sendEmail({
      type: 'broadcast', dedupeKey: `broadcast:${b.id}:${r.customer_email.toLowerCase()}`, to: r.customer_email,
      customer: true, approved: true, broadcastId: b.id, ...tpl.broadcast(subject, body, r.customer_name),
    });
    if (s.status === 'sent') result.sent += 1; else if (s.status === 'failed') result.failed += 1; else if (s.status === 'held') result.held += 1;
  }
  return result;
}

module.exports = { recipients, sendTest, sendBroadcast };
