/**
 * JustBread — Admin Orders API
 * GET /api/orders
 *
 * Backs the /admin dashboard. Requires the x-admin-password header to match
 * ADMIN_PASSWORD (set in Vercel env vars) — this is a low-value internal
 * tool for a solo operator, not a customer-facing surface, so a single
 * shared password is proportionate.
 */

const crypto = require('crypto');
const { query } = require('../db/client');

function passwordMatches(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!passwordMatches(req.headers['x-admin-password'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await query(
      `SELECT id, customer_email, customer_name, loaves, fulfillment_type,
              order_type, cadence, status, created_at,
              raw_metadata->>'delivery_override' AS delivery_override
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
