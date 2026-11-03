/**
 * /api/standing-orders  (admin only). SPEC.md 6b.
 *   GET                       list all standing orders
 *   POST { action, ... }      create | update | skip | unskip | pause | resume | end | override
 */

const { query } = require('../../db/client');
const { isAdminRequest } = require('../adminAuth');
const so = require('../standingOrders');

module.exports = async function handler(req, res) {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') {
      const { rows } = await query('SELECT * FROM standing_orders ORDER BY paused, name');
      return res.status(200).json({ standingOrders: rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { action, id, thursday, fields } = req.body || {};
    const actions = {
      create: () => so.create(fields || {}),
      update: () => so.update(id, fields || {}),
      skip: () => so.skip(id, thursday),
      unskip: () => so.unskip(id, thursday),
      pause: () => so.pause(id),
      resume: () => so.resume(id),
      end: () => so.end(id, thursday),
      override: () => so.overrideOne(id, thursday, fields || {}),
    };
    if (!actions[action]) return res.status(400).json({ error: 'unknown action' });
    return res.status(200).json(await actions[action]());
  } catch (err) {
    if (err instanceof so.StandingOrderError) return res.status(400).json({ error: err.message });
    console.error('standing-orders failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
