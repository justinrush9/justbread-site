/**
 * The one place a Stripe client is created.
 *
 * Production uses STRIPE_SECRET_KEY (the live key). Every other environment
 * (Vercel preview builds, local) uses STRIPE_TEST_SECRET_KEY and refuses to
 * start with anything but an sk_test_ key, so a preview can never charge,
 * skip, or change a real subscriber, even if a setting is wrong.
 */

const Stripe = require('stripe');

function stripeKey(env = process.env) {
  if (env.VERCEL_ENV === 'production') return env.STRIPE_SECRET_KEY;
  const key = env.STRIPE_TEST_SECRET_KEY || '';
  if (!key.startsWith('sk_test_')) {
    throw new Error('Not production: STRIPE_TEST_SECRET_KEY must be set to an sk_test_ key.');
  }
  return key;
}

let client;
function getStripe() {
  if (!client) client = new Stripe(stripeKey());
  return client;
}

// Lazy proxy so modules can keep `const stripe = ...` at the top without
// creating (or failing) at import time.
const stripe = new Proxy({}, { get: (_t, prop) => getStripe()[prop] });

module.exports = { stripe, getStripe, stripeKey };
