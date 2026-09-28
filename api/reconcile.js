/**
 * JustBread — Reconciliation sweep
 * GET /api/reconcile?days=3
 *
 * Catches orders the live webhook missed (a dropped delivery, a signature
 * mismatch, a cold-start timeout, the endpoint briefly down) by re-walking
 * Stripe's own Events API for the lookback window and replaying anything
 * not already in `orders`. Safe to run as often as you like — insertion is
 * idempotent on stripe_event_id (see lib/orderProcessing.js), so an event
 * already in the table is just skipped, not duplicated.
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
const { processCheckoutSessionCompleted, processInvoicePaid } = require('../lib/orderProcessing');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const HANDLERS = {
  'checkout.session.completed': processCheckoutSessionCompleted,
  'invoice.paid': processInvoicePaid,
};

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 3, 1), 30);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const summary = { days, checked: 0, inserted: 0, skipped: 0, errors: [] };

  for (const [type, processEvent] of Object.entries(HANDLERS)) {
    try {
      // stripe-node's list() result is directly async-iterable and
      // auto-paginates — no need for a separate autoPagingEach call.
      for await (const event of stripe.events.list({ type, created: { gte: since }, limit: 100 })) {
        summary.checked += 1;
        try {
          const result = await processEvent(event, stripe);
          if (result?.inserted) summary.inserted += 1;
          else summary.skipped += 1;
        } catch (err) {
          console.error(`Reconcile: failed to process ${type} event ${event.id}:`, err.message);
          summary.errors.push({ eventId: event.id, type, message: err.message });
        }
      }
    } catch (err) {
      console.error(`Reconcile: failed to list ${type} events:`, err.message);
      summary.errors.push({ type, message: err.message });
    }
  }

  return res.status(200).json(summary);
};
