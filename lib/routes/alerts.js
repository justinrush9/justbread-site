/**
 * /api/alerts  (admin only). SPEC.md 9c, 9d.
 *   GET  ?view=alerts | cancellations | emails
 *   POST { action: 'read', id } | { action: 'read_all' }
 *   POST { action: 'push_subscribe', subscription, device }
 *   POST { action: 'customer_emails', on: true|false }
 *   POST { action: 'broadcast_test', subject, body }
 *   POST { action: 'broadcast', subject, body, pause_until? }
 */

const { query } = require('../../db/client');
const { isAdminRequest } = require('../adminAuth');
const settings = require('../settings');
const { publicKey, subscribe } = require('../push');
const { previews } = require('../emailTemplates');
const { recipients, sendTest, sendBroadcast } = require('../broadcast');
const { isThursday } = require('../dates');

module.exports = async function handler(req, res) {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') {
      const view = req.query?.view || 'alerts';
      if (view === 'alerts') {
        const { rows } = await query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200');
        return res.status(200).json({ alerts: rows, unread: rows.filter((a) => !a.read_at).length, vapid_public_key: await publicKey() });
      }
      if (view === 'cancellations') {
        const { rows } = await query(
          `SELECT stripe_subscription_id, customer_name, customer_email, cadence, loaves, status,
                  cancel_at_period_end, cancel_at, next_renewal_at, ended_at, ended_reason, cancellation_comment, updated_at
           FROM subscriptions
           WHERE (ended_at IS NOT NULL AND ended_at > now() - INTERVAL '60 days')
              OR (cancel_at_period_end AND status <> 'canceled')
              OR (cancel_at IS NOT NULL AND status <> 'canceled')
           ORDER BY COALESCE(ended_at, updated_at) DESC`,
        );
        return res.status(200).json({ cancellations: rows });
      }
      if (view === 'emails') {
        const [{ rows: recent }, list] = await Promise.all([
          query('SELECT email_type, recipient, status, subject, last_error, sent_at FROM emails_sent ORDER BY id DESC LIMIT 30'),
          recipients(),
        ]);
        return res.status(200).json({
          customer_emails_enabled: (await settings.get('customer_emails_enabled', false)) === true,
          previews: previews(), recent, subscriber_count: list.length,
          production: process.env.VERCEL_ENV === 'production',
        });
      }
      return res.status(400).json({ error: 'unknown view' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = req.body || {};
    if (b.action === 'read') { await query('UPDATE alerts SET read_at = now() WHERE id = $1 AND read_at IS NULL', [b.id]); return res.status(200).json({ ok: true }); }
    if (b.action === 'read_all') { await query('UPDATE alerts SET read_at = now() WHERE read_at IS NULL'); return res.status(200).json({ ok: true }); }
    if (b.action === 'push_subscribe') { await subscribe(b.subscription, b.device); return res.status(200).json({ ok: true }); }
    if (b.action === 'customer_emails') { await settings.set('customer_emails_enabled', b.on === true); return res.status(200).json({ customer_emails_enabled: b.on === true }); }
    if (b.action === 'broadcast_test') return res.status(200).json(await sendTest(b.subject, b.body));
    if (b.action === 'broadcast') {
      if (b.pause_until && !isThursday(b.pause_until)) return res.status(400).json({ error: 'Pause until must be a Thursday.' });
      const { stripe } = require('../stripeClient');
      const { skipUntil } = require('../subscriptionControls');
      return res.status(200).json(await sendBroadcast({ subject: b.subject, body: b.body, pauseUntil: b.pause_until }, { stripe, skipUntil }));
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return res.status(503).json({ error: 'Database not set up yet. Open /admin/setup/.' });
    console.error('alerts failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
