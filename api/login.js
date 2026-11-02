/**
 * POST /api/login   { password }  -> sets the 30-day admin cookie
 * POST /api/login   { logout: true } -> clears it
 * GET  /api/login   -> { loggedIn }
 */

const { timingSafeStringEqual, makeSessionCookie, clearSessionCookie, hasValidSession } = require('../lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ loggedIn: hasValidSession(req) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { password, logout } = req.body || {};
  if (logout) {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ loggedIn: false });
  }
  if (!timingSafeStringEqual(password, process.env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return res.status(401).json({ error: 'Wrong password.' });
  }
  res.setHeader('Set-Cookie', makeSessionCookie());
  return res.status(200).json({ loggedIn: true });
};
