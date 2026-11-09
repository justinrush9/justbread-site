/**
 * /api/referral   PUBLIC (no login). SPEC.md 9e.
 *   GET  ?session_id=cs_...                    -> { ask, choices }
 *   POST { session_id, source, other? }         -> { saved }
 * The checkout session is checked with Stripe (real and paid) every time.
 */

const { stripe } = require('../stripeClient');
const referrals = require('../referrals');

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await referrals.shouldAsk(stripe, req.query?.session_id));
    if (req.method === 'POST') {
      const { session_id: sessionId, source, other } = req.body || {};
      return res.status(200).json(await referrals.record(stripe, sessionId, source, other));
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Never bother a customer with an error here; the question is optional.
    if (err.code === '42P01') return res.status(200).json({ ask: false });
    return res.status(400).json({ error: err.message });
  }
};
