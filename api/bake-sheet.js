/**
 * GET /api/bake-sheet               -> { thursdays: [...] } upcoming dates with orders
 * GET /api/bake-sheet?date=YYYY-MM-DD -> the full sheet for that Thursday (lib/sheet.js)
 * Admin only (cookie, password header, or cron secret).
 */

const { isAdminRequest } = require('../lib/adminAuth');
const { buildSheet, upcomingThursdays } = require('../lib/sheet');
const { todayCentral, isThursday } = require('../lib/dates');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const date = req.query?.date;
  try {
    if (!date) return res.status(200).json({ today: todayCentral(), thursdays: await upcomingThursdays(todayCentral()) });
    if (!isThursday(date)) return res.status(400).json({ error: 'date must be a Thursday, YYYY-MM-DD' });
    return res.status(200).json(await buildSheet(date));
  } catch (err) {
    console.error('Bake sheet error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
