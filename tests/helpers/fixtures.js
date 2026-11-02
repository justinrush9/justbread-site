// Minimal Stripe objects shaped like API version 2024-06-20 (stripe-node 16).
const { PRICES } = require('../../lib/prices');

const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000);
let n = 0;
const id = (p) => `${p}_test${++n}`;

const weeklyLocalItems = (loaves = 1) => [
  { price: { id: PRICES.loaf.weekly, recurring: { interval: 'week', interval_count: 1 } }, quantity: loaves },
  { price: { id: PRICES.localSub.weekly, recurring: { interval: 'week', interval_count: 1 } }, quantity: 1 },
];

function invoiceEvent(type, { invoiceId, created, billingReason = 'subscription_cycle', amount = 1500, sub = 'sub_A', eventCreated }) {
  return {
    id: id('evt'), type, created: eventCreated || secs(created),
    data: { object: {
      id: invoiceId, object: 'invoice', customer: 'cus_A', subscription: sub,
      customer_email: 'a@example.com', customer_name: 'Ann Baker',
      billing_reason: billingReason, created: secs(created),
      amount_paid: type === 'invoice.paid' ? amount : 0, amount_due: amount,
      payment_intent: `pi_${invoiceId}`,
      lines: { data: weeklyLocalItems() },
      subscription_details: { metadata: { zip: '60134' } },
    } },
  };
}

function subscriptionEvent(type, { created, sub = {}, previous }) {
  return {
    id: id('evt'), type, created: secs(created),
    data: {
      object: {
        id: 'sub_A', customer: 'cus_A', status: 'active', metadata: { zip: '60134' },
        items: { data: weeklyLocalItems() },
        current_period_end: secs('2026-11-16T12:00:00Z'),
        cancel_at_period_end: false, cancel_at: null, pause_collection: null,
        ended_at: null, cancellation_details: {},
        ...sub,
      },
      ...(previous ? { previous_attributes: previous } : {}),
    },
  };
}

function fakeStripe({ lineItems = [] } = {}) {
  return {
    checkout: { sessions: { listLineItems: async () => ({ data: lineItems }) } },
    subscriptions: { retrieve: async () => ({ items: { data: weeklyLocalItems() }, metadata: {} }) },
    customers: {
      retrieve: async () => ({
        name: 'Ann Baker', email: 'a@example.com', phone: null,
        shipping: { name: 'Ann Baker', address: { line1: '1 Main St', city: 'Geneva', state: 'IL', postal_code: '60134', country: 'US' } },
      }),
    },
  };
}

module.exports = { secs, id, invoiceEvent, subscriptionEvent, fakeStripe, weeklyLocalItems };
