/**
 * One function for every admin endpoint. Vercel's Hobby plan allows at most
 * 12 server functions per deployment, so the admin endpoints live in
 * lib/routes/ and vercel.json rewrites /api/<name> to /api/admin?route=<name>.
 * Each route module does its own auth check, exactly as before.
 */

const ROUTES = {
  alerts: require('../lib/routes/alerts'),
  'email-prefs': require('../lib/routes/email-prefs'),
  'bake-sheet': require('../lib/routes/bake-sheet'),
  login: require('../lib/routes/login'),
  migrate: require('../lib/routes/migrate'),
  'move-to-monday': require('../lib/routes/move-to-monday'),
  'order-edit': require('../lib/routes/order-edit'),
  orders: require('../lib/routes/orders'),
  production: require('../lib/routes/production'),
  route: require('../lib/routes/route'),
  'standing-orders': require('../lib/routes/standing-orders'),
  stops: require('../lib/routes/stops'),
  'subscription-control': require('../lib/routes/subscription-control'),
};

module.exports = async function handler(req, res) {
  const route = ROUTES[req.query?.route];
  if (!route) return res.status(404).json({ error: 'Not found' });
  return route(req, res);
};

module.exports.ROUTES = ROUTES;
