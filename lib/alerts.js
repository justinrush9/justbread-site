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
  return { created: result.rowCount > 0 };
}

module.exports = { addAlert };
