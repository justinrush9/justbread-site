/**
 * Settings (SPEC.md section 12): key/value, with code defaults.
 *   production  recipe and timing constants (lib/production.js DEFAULTS)
 *   home_address  route start and end (section 8)
 */

const { query } = require('../db/client');
const { DEFAULTS } = require('./production');

const EDITABLE_PRODUCTION = ['start_time', 'starter_buffer', 'fridge_by', 'starter_g', 'flour_g', 'water_g', 'salt_g', 'batch'];

async function get(key, fallback) {
  const { rows: [r] } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return r ? r.value : fallback;
}

async function set(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  return value;
}

async function productionConstants() {
  return { ...DEFAULTS, ...(await get('production', {})) };
}

async function setProductionConstants(changes) {
  const clean = {};
  for (const [k, v] of Object.entries(changes || {})) {
    if (!EDITABLE_PRODUCTION.includes(k)) continue;
    if (['start_time', 'fridge_by'].includes(k)) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`${k} must be HH:MM`);
    } else if (!(typeof v === 'number' && v >= 0 && v < 10000)) {
      throw new Error(`${k} must be a number`);
    }
    clean[k] = v;
  }
  return set('production', { ...(await get('production', {})), ...clean });
}

module.exports = { get, set, productionConstants, setProductionConstants, EDITABLE_PRODUCTION };
