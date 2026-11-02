/**
 * JustBread — Reconciliation sweep
 * GET /api/reconcile?days=3
 *
 * Catches orders the live webhook missed (a dropped delivery, a signature
 * mismatch, a cold-start timeout, the endpoint briefly down) by re-walking
 * Stripe's own Events API for the lookback window and replaying anything
 * not already applied. Safe to run as often as you like: every handler in
 * lib/stripeEvents.js is idempotent, so a replayed event changes nothing.
 *
 * Two ways in:
 *   - x-admin-password header — the "Sync from Stripe" button on /admin.
 *   - Authorization: Bearer <CRON_SECRET> — how the daily cron in
 *     vercel.json calls it automatically. Set CRON_SECRET in Vercel env
 *     vars.
 *
 * Query params:
 *   days   how far back to look, default 3, max 30 (Stripe keeps events
 *          ~30 days). Bump this for a one-off catch-up run, e.g. right
 *          after fixing something that was broken for a week.
 */

const Stripe = require('stripe');
const { isAdminRequest } = require('../lib/adminAuth');
const { processEvent, EVENT_TYPES } = require('../lib/stripeEvents');
const { refreshAllSubscriptions } = require('../lib/subscriptions');
const { freezePast } = require('../lib/standingOrders');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Pull every relevant event in the window, then replay oldest first, so
// state builds up in the order it happened (the handlers also tolerate
// out-of-order events, this just keeps the common case simple).
async function collectEvents(since) {
  const events = [];
  for await (const event of stripe.events.list({ types: EVENT_TYPES, created: { gte: since }, limit: 100 })) {
    events.push(event);
  }
  return events.sort((a, b) => a.created - b.created);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 3, 1), 30);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const summary = { days, checked: 0, inserted: 0, skipped: 0, errors: [] };

  let events;
  try {
    events = await collectEvents(since);
  } catch (err) {
    console.error('Reconcile: failed to list events:', err.message);
    return res.status(502).json({ ...summary, errors: [{ message: err.message }] });
  }

  for (const event of events) {
    summary.checked += 1;
    try {
      const result = await processEvent(event, stripe);
      if (result?.inserted || result?.updated) summary.inserted += 1;
      else summary.skipped += 1;
    } catch (err) {
      console.error(`Reconcile: failed to process ${event.type} ${event.id}:`, err.message);
      summary.errors.push({ eventId: event.id, type: event.type, message: err.message });
    }
  }

  try {
    summary.subscriptions = await refreshAllSubscriptions(stripe);
  } catch (err) {
    console.error('Reconcile: subscription refresh failed:', err.message);
    summary.errors.push({ type: 'subscription_refresh', message: err.message });
  }

  try {
    summary.standingOrders = await freezePast();
  } catch (err) {
    console.error('Reconcile: standing-order freeze failed:', err.message);
    summary.errors.push({ type: 'standing_freeze', message: err.message });
  }

  return res.status(200).json(summary);
};
