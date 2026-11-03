/**
 * Push notifications to Jay's phone (SPEC.md 9c). The keys that sign pushes
 * (VAPID) are generated on first use and kept in settings, so there is no
 * extra Vercel setting to manage. Each device that taps "Turn on
 * notifications" is stored in push_subscriptions; dead ones are removed.
 */

const webpush = require('web-push');
const { query } = require('../db/client');
const settings = require('./settings');

async function vapid() {
  let v = await settings.get('vapid', null);
  if (!v) { v = webpush.generateVAPIDKeys(); await settings.set('vapid', v); }
  return v;
}

async function publicKey() { return (await vapid()).publicKey; }

async function subscribe(sub, device) {
  if (!sub?.endpoint || !sub?.keys) throw new Error('bad subscription');
  await query(
    `INSERT INTO push_subscriptions (endpoint, keys, device) VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys, device = EXCLUDED.device`,
    [sub.endpoint, JSON.stringify(sub.keys), device || null],
  );
}

async function pushAll(payload, { send = webpush.sendNotification } = {}) {
  const v = await vapid();
  const { rows } = await query('SELECT * FROM push_subscriptions');
  let sent = 0;
  for (const r of rows) {
    try {
      await send({ endpoint: r.endpoint, keys: r.keys }, JSON.stringify(payload), {
        vapidDetails: { subject: 'mailto:info@justbread.shop', publicKey: v.publicKey, privateKey: v.privateKey },
        TTL: 24 * 3600,
      });
      sent += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await query('DELETE FROM push_subscriptions WHERE id = $1', [r.id]);
      else console.error('push failed:', err.message);
    }
  }
  return { devices: rows.length, sent };
}

module.exports = { publicKey, subscribe, pushAll };
