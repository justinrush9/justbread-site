/**
 * GET /api/bake-sheet               -> { thursdays: [...] } upcoming dates with orders
 * GET /api/bake-sheet?date=YYYY-MM-DD -> the full sheet for that Thursday (lib/sheet.js)
 * Admin only (cookie, password header, or cron secret).
 */

const { isAdminRequest } = require('../adminAuth');
const { buildSheet, upcomingThursdays } = require('../sheet');
const { todayCentral, isThursday } = require('../dates');
const { deliveryDates } = require('../weeks');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const date = req.query?.date;
  try {
    if (!date) {
      const today = todayCentral();
      const thursdays = await upcomingThursdays(today);
      // Delivery days for these weeks and the next few, for chip labels (7f).
      const { thursdaysBetween, shiftDate } = require('../dates');
      const weeks = [...thursdays, ...thursdaysBetween(shiftDate(today, -7), shiftDate(today, 70))];
      return res.status(200).json({ today, thursdays, delivery_dates: await deliveryDates(weeks) });
    }
    if (!isThursday(date)) return res.status(400).json({ error: 'date must be a Thursday, YYYY-MM-DD' });
    return res.status(200).json(await buildSheet(date));
  } catch (err) {
    // 42P01 undefined table, 42703 undefined column: schema not applied yet.
    if (err.code === '42P01' || err.code === '42703') {
      return res.status(503).json({ error: 'Database not set up yet. Open /admin/setup/ and tap "Set up database".' });
    }
    console.error('Bake sheet error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
