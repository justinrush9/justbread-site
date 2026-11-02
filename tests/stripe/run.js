// Smoke check: proves the runner can reach Stripe in test mode and drive a
// test clock. Prints JSON to stdout.
const key = process.env.STRIPE_TEST_KEY || '';
if (!key.startsWith('sk_test_')) {
  console.log(JSON.stringify({ ok: false, error: 'STRIPE_TEST_KEY missing or not a test key' }));
  process.exit(0);
}
const stripe = require('stripe')(key);
(async () => {
  const out = { ok: false, steps: [] };
  try {
    const start = Math.floor(Date.UTC(2026, 10, 2, 12) / 1000); // Mon Nov 2 2026
    let clock = await stripe.testHelpers.testClocks.create({ frozen_time: start, name: 'smoke' });
    out.steps.push({ created: clock.id, frozen_time: clock.frozen_time });
    clock = await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: start + 7 * 86400 });
    for (let i = 0; i < 30 && clock.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      clock = await stripe.testHelpers.testClocks.retrieve(clock.id);
    }
    out.steps.push({ advanced_to: new Date(clock.frozen_time * 1000).toISOString(), status: clock.status });
    await stripe.testHelpers.testClocks.del(clock.id);
    out.ok = clock.status === 'ready';
  } catch (e) {
    out.error = e.message;
  }
  console.log(JSON.stringify(out, null, 2));
})();
