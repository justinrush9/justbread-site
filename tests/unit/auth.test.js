const test = require('node:test');
const assert = require('node:assert');

test('30-day session cookie: valid, expires, and dies when the password changes', () => {
  process.env.ADMIN_PASSWORD = 'pw1';
  delete require.cache[require.resolve('../../lib/adminAuth')];
  const auth = require('../../lib/adminAuth');
  const now = Date.UTC(2026, 10, 2);
  const cookie = auth.makeSessionCookie(now).split(';')[0];
  const req = { headers: { cookie: `other=1; ${cookie}` } };
  assert.equal(auth.hasValidSession(req, now + 29 * 86400e3), true);
  assert.equal(auth.hasValidSession(req, now + 31 * 86400e3), false);
  assert.equal(auth.hasValidSession({ headers: { cookie: cookie.replace(/.$/, 'x') } }, now), false, 'tampered');
  process.env.ADMIN_PASSWORD = 'pw2';
  assert.equal(auth.hasValidSession(req, now + 86400e3), false, 'password change logs out');
  assert.match(auth.makeSessionCookie(now), /HttpOnly; Secure; SameSite=Strict/);
});
