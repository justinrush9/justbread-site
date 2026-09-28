/**
 * JustBread — Bake Sheet API
 * GET /api/bake-sheet                 -> upcoming/recent fulfillment dates with counts
 * GET /api/bake-sheet?date=YYYY-MM-DD -> full production detail for that date
 *
 * This is the actual "what do I bake, and where does it go" view.
 * /api/orders is a payment log ordered by when Stripe charged someone;
 * this groups by fulfillment_date (see lib/fulfillment.js) and delivery
 * mechanic instead, which is what a bake day is organized around.
 */

const { query } = require('../db/client');
const { isAdminRequest } = require('../lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  const date = req.query?.date;

  // No date -> list fulfillment dates that have orders, so the admin page
  // can offer them as quick picks instead of the person guessing a date.
  if (!date) {
    try {
      const result = await query(
        `SELECT fulfillment_date, COUNT(*)::int AS order_count, COALESCE(SUM(loaves), 0)::int AS loaves
         FROM orders
         WHERE fulfillment_date IS NOT NULL
           AND fulfillment_date >= CURRENT_DATE - INTERVAL '7 days'
         GROUP BY fulfillment_date
         ORDER BY fulfillment_date`,
      );
      return res.status(200).json({ dates: result.rows });
    } catch (err) {
      console.error('Bake sheet dates fetch error:', err.message);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  try {
    const [orders, totals] = await Promise.all([
      query(
        `SELECT id, customer_name, customer_email, loaves, delivery_method,
                pickup_location, shipping_address, order_type, cadence, status
         FROM orders
         WHERE fulfillment_date = $1
         ORDER BY delivery_method,
                  pickup_location NULLS LAST,
                  shipping_address->>'postal_code' NULLS LAST,
                  customer_name`,
        [date],
      ),
      query(
        `SELECT delivery_method, COUNT(*)::int AS order_count, COALESCE(SUM(loaves), 0)::int AS loaves
         FROM orders
         WHERE fulfillment_date = $1
         GROUP BY delivery_method`,
        [date],
      ),
    ]);

    const totalLoaves = totals.rows.reduce((sum, r) => sum + r.loaves, 0);

    return res.status(200).json({
      date,
      totalLoaves,
      totalsByMethod: totals.rows,
      orders: orders.rows,
    });
  } catch (err) {
    console.error('Bake sheet fetch error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
