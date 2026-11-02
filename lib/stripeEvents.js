/**
 * The one place that maps a Stripe event type to what the app does with it.
 * api/webhook.js and api/reconcile.js both dispatch through here.
 *
 * The webhook endpoint in Stripe must be subscribed to every type in
 * EVENT_TYPES (SPEC.md section 3).
 */

const {
  processCheckoutSessionCompleted,
  processInvoicePaid,
  processInvoicePaymentFailed,
  processChargeRefunded,
} = require('./orderProcessing');
const { processSubscriptionEvent } = require('./subscriptions');

const HANDLERS = {
  'checkout.session.completed': processCheckoutSessionCompleted,
  'invoice.paid': processInvoicePaid,
  'invoice.payment_failed': processInvoicePaymentFailed,
  'charge.refunded': processChargeRefunded,
  'customer.subscription.created': processSubscriptionEvent,
  'customer.subscription.updated': processSubscriptionEvent,
  'customer.subscription.deleted': processSubscriptionEvent,
};

const EVENT_TYPES = Object.keys(HANDLERS);

async function processEvent(event, stripe) {
  const handler = HANDLERS[event.type];
  if (!handler) return { skipped: `unhandled type ${event.type}` };
  return handler(event, stripe);
}

module.exports = { processEvent, EVENT_TYPES };
