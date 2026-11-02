/**
 * /api/move-to-monday  (admin only). SPEC.md 4a, existing subscriptions.
 *   GET   preview: every subscription and what would happen to it. Changes nothing.
 *   POST  { confirm: "MOVE", ids: ["sub_..."] } moves only those listed.
 * Run only after the notice email has gone out.
 */

const Stripe = require('stripe');
const { isAdminRequest } = require('../lib/adminAuth');
const { plan, apply } = require('../lib/moveToMonday');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') return res.status(200).json({ preview: await plan(stripe) });
    if (req.method === 'POST') {
      const { confirm, ids } = req.body || {};
      if (confirm !== 'MOVE' || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'Send { confirm: "MOVE", ids: [...] }' });
      }
      return res.status(200).json({ results: await apply(stripe, ids) });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('move-to-monday failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
