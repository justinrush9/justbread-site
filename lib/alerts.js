/**
 * Alerts list (SPEC.md 9c). One row per Stripe event at most: the unique
 * stripe_event_id means a resent event never creates a second alert.
 * Push and email delivery of alerts is built in Phase 7; this only records.
 */

const { query } = require('../db/client');

async function addAlert({ eventId, type, subscriptionId, message }) {
  const result = await query(
    `INSERT INTO alerts (stripe_event_id, type, stripe_subscription_id, message)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING id`,
    [eventId || null, type, subscriptionId || null, message],
  );
  const created = result.rowCount > 0;
  // Tell Jay by email and push, independently: one failing never stops the
  // other, and neither can fail the webhook (the alert is already saved).
  if (created) await notify({ id: result.rows[0].id, type, message });
  return { created };
}

async function notify(a) {
  const { sendEmail, alertAddress } = require('./email');
  const { alert: tpl } = require('./emailTemplates');
  const { pushAll } = require('./push');
  try {
    await sendEmail({ type: 'alert', dedupeKey: `alert:${a.id}`, to: await alertAddress(), customer: false, ...tpl(a) });
  } catch (err) { console.error('alert email failed:', err.message); }
  try {
    const r = await pushAll({ title: 'JustBread', body: a.message, url: '/admin/alerts/' });
    if (r.sent) await query('UPDATE alerts SET pushed_at = now() WHERE id = $1', [a.id]);
  } catch (err) { console.error('alert push failed:', err.message); }
}

module.exports = { addAlert };
