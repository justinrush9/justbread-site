/**
 * /api/production  (admin only). SPEC.md 9b.
 *   GET  ?date=YYYY-MM-DD           schedule for that Thursday
 *   GET  ?settings=1                current constants
 *   POST { date, action: 'start' | 'undo', step }
 *   POST { date, action: 'start_time', value: 'HH:MM' | null }   this week only
 *   POST { action: 'settings', values: {...} }                    defaults
 */

const { isAdminRequest } = require('../adminAuth');
const plan = require('../productionPlan');
const settings = require('../settings');
const { isThursday } = require('../dates');

module.exports = async function handler(req, res) {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') {
      if (req.query?.settings) return res.status(200).json({ constants: await settings.productionConstants(), editable: settings.EDITABLE_PRODUCTION });
      if (!isThursday(req.query?.date)) return res.status(400).json({ error: 'date must be a Thursday' });
      return res.status(200).json(await plan.planFor(req.query.date));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { date, action, step, value, values } = req.body || {};
    if (action === 'settings') return res.status(200).json({ constants: await settings.setProductionConstants(values) });
    if (!isThursday(date)) return res.status(400).json({ error: 'date must be a Thursday' });
    if (action === 'start') return res.status(200).json(await plan.markStarted(date, step));
    if (action === 'undo') return res.status(200).json(await plan.undoStarted(date, step));
    if (action === 'start_time') return res.status(200).json(await plan.setStartTime(date, value || null));
    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};
