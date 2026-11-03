const test = require('node:test');
const assert = require('node:assert');
const { stripeKey } = require('../../lib/stripeClient');

test('previews only ever get a test key', () => {
  assert.equal(stripeKey({ VERCEL_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_x' }), 'sk_live_x');
  assert.equal(stripeKey({ VERCEL_ENV: 'preview', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_TEST_SECRET_KEY: 'sk_test_y' }), 'sk_test_y');
  assert.throws(() => stripeKey({ VERCEL_ENV: 'preview', STRIPE_SECRET_KEY: 'sk_live_x' }), /sk_test_/);
  assert.throws(() => stripeKey({ VERCEL_ENV: 'preview', STRIPE_TEST_SECRET_KEY: 'sk_live_oops' }), /sk_test_/);
  assert.throws(() => stripeKey({}), /sk_test_/);
});
