/**
 * POST /api/subscription-control  (admin only)
 * Body: { subscriptionId, action: 'skip_week' | 'skip_until' | 'resume', thursday? }
 *   skip_week   thursday = the Thursday to skip (must be the next renewal's)
 *   skip_until  thursday = the first Thursday they get bread again
 * SPEC.md 6d. The resulting Stripe change syncs back through
 * customer.subscription.updated like any portal change.
 */

const Stripe = require('stripe');
const { isAdminRequest } = require('../lib/adminAuth');
const { skipThisWeek, skipUntil, resume, ControlError } = require('../lib/subscriptionControls');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { subscriptionId, action, thursday } = req.body || {};
  if (!subscriptionId || !/^sub_/.test(subscriptionId)) return res.status(400).json({ error: 'subscriptionId required' });
  if (thursday && !/^\d{4}-\d{2}-\d{2}$/.test(thursday)) return res.status(400).json({ error: 'thursday must be YYYY-MM-DD' });

  try {
    let result;
    if (action === 'skip_week') result = await skipThisWeek(stripe, subscriptionId, thursday);
    else if (action === 'skip_until') result = await skipUntil(stripe, subscriptionId, thursday);
    else if (action === 'resume') result = await resume(stripe, subscriptionId);
    else return res.status(400).json({ error: 'unknown action' });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ControlError) return res.status(409).json({ error: err.message });
    console.error('subscription-control failed:', err.message);
    return res.status(500).json({ error: 'Stripe update failed' });
  }
};
