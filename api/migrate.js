/**
 * POST /api/migrate  (admin only) -> applies db/schema.sql.
 * Idempotent and additive (CREATE/ADD ... IF NOT EXISTS), so running it
 * twice is harmless. Used once per database: a preview/test copy, and the
 * live database at go-live (SPEC.md section 3).
 */

const fs = require('fs');
const path = require('path');
const { getPool } = require('../db/client');
const { isAdminRequest } = require('../lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  try {
    await getPool().query(sql); // multi-statement, no parameters
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return res.status(200).json({ ok: true, tables: rows.map((r) => r.table_name) });
  } catch (err) {
    console.error('migrate failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
