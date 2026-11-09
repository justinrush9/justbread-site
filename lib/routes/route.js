/**
 * /api/route  (admin only). SPEC.md section 8.
 *   GET  ?date=YYYY-MM-DD                  route status + ordered drive stops (never calls Google)
 *   POST { date, action: 'optimize' }       compute if the stop set changed (or never computed)
 *   POST { date, action: 'reoptimize' }     force a new Google optimization
 *   POST { action: 'home', value }          set the home address (start and end)
 *   POST { action: 'pickup_address', label, value }  street address for a pickup point
 */

const { isAdminRequest } = require('../adminAuth');
const { computeRoute, routeStatus, replanFromHere } = require('../route');
const { buildSheet, setHandedOff } = require('../sheet');
const settings = require('../settings');
const { isThursday } = require('../dates');

async function view(date) {
  const [status, sheet, pickupAddresses] = await Promise.all([routeStatus(date), buildSheet(date), settings.get('pickup_addresses', {})]);
  const stops = sheet.stops
    .filter((s) => s.kind === 'local_delivery' || s.kind === 'pickup')
    .sort((a, b) => (a.route_position ?? 1e9) - (b.route_position ?? 1e9))
    .map((s) => {
      const names = [...new Set(sheet.entries.filter((e) => e.stop_key === s.stop_key && !e.skipped).map((e) => e.customer_name))];
      const a = s.address;
      const query = s.kind === 'local_delivery' && a
        ? [a.line1, a.line2, a.city, a.state, a.postal_code].filter(Boolean).join(', ')
        : (pickupAddresses[s.label] || s.label);
      return { stop_key: s.stop_key, kind: s.kind, title: s.kind === 'pickup' ? s.label : names.join(', '), names, loaves: s.loaves, query, delivered_at: s.delivered_at, handed_off_at: s.handed_off_at, route_position: s.route_position };
    });
  return { ...status, delivery_date: sheet.delivery_date, stops, pickup_addresses: pickupAddresses };
}

module.exports = async function handler(req, res) {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') {
      if (!isThursday(req.query?.date)) return res.status(400).json({ error: 'date must be a Thursday' });
      return res.status(200).json(await view(req.query.date));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { date, action, value, label } = req.body || {};
    if (action === 'home') {
      if (!value || String(value).trim().length < 8) return res.status(400).json({ error: 'Enter the full address.' });
      await settings.set('home_address', String(value).trim());
      return res.status(200).json({ home_address: String(value).trim() });
    }
    if (action === 'pickup_address') {
      const map = await settings.get('pickup_addresses', {});
      if (value) map[label] = String(value).trim(); else delete map[label];
      await settings.set('pickup_addresses', map);
      return res.status(200).json({ pickup_addresses: map });
    }
    if (!isThursday(date)) return res.status(400).json({ error: 'date must be a Thursday' });
    if (action === 'handoff') {
      await setHandedOff(date, req.body.stop_key, !!req.body.on);
      return res.status(200).json(await view(date));
    }
    if (action === 'replan') {
      try { await replanFromHere(date, req.body.position || null); } catch (e) { return res.status(409).json({ error: e.message }); }
      return res.status(200).json(await view(date));
    }
    if (action === 'optimize' || action === 'reoptimize') {
      await computeRoute(date, { force: action === 'reoptimize' });
      return res.status(200).json(await view(date));
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return res.status(503).json({ error: 'Database not set up yet. Open /admin/setup/.' });
    console.error('route failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
