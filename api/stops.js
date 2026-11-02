/**
 * POST /api/stops  (admin only)
 *   { thursday, stop_key, delivered: true|false }   tick / untick a stop (7c)
 *   { thursday, extras: n|null }                     override extras for the week (9b)
 */

const { isAdminRequest } = require('../lib/adminAuth');
const { setDelivered, setExtrasOverride } = require('../lib/sheet');
const { isThursday } = require('../lib/dates');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { thursday, stop_key: stopKey, delivered, extras } = req.body || {};
  if (!isThursday(thursday)) return res.status(400).json({ error: 'thursday must be a Thursday' });
  try {
    if ('extras' in (req.body || {})) return res.status(200).json(await setExtrasOverride(thursday, extras));
    if (!stopKey) return res.status(400).json({ error: 'stop_key required' });
    return res.status(200).json(await setDelivered(thursday, stopKey, !!delivered));
  } catch (err) {
    console.error('stops failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
