/**
 * JustBread — Admin Orders API
 * GET /api/orders
 *
 * Backs the /admin dashboard. Requires the x-admin-password header to match
 * ADMIN_PASSWORD (set in Vercel env vars) — this is a low-value internal
 * tool for a solo operator, not a customer-facing surface, so a single
 * shared password is proportionate.
 */

const { query } = require('../db/client');
const { isAdminRequest } = require('../lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await query(
      `SELECT id, customer_email, customer_name, loaves, fulfillment_type,
              order_type, cadence, status, created_at,
              delivery_method, pickup_location, shipping_address,
              fulfillment_date
       FROM orders
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    return res.status(200).json({ orders: result.rows });
  } catch (err) {
    console.error('Admin orders fetch error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
