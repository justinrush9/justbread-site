/**
 * /api/email-prefs?e=<email>&s=<signature>   PUBLIC (no login), signed link.
 *   GET   a small page with a button (link scanners can't unsubscribe anyone)
 *   POST  turns Delivered / Shipped emails off (also the one-click
 *         List-Unsubscribe POST that mail apps send). ?on=1 turns them back on.
 */

const { verifyOptOut, setDeliveryEmails } = require('../email');

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:Arial,sans-serif;max-width:440px;margin:15vh auto;padding:0 16px;line-height:1.5;color:#111}button{font:inherit;font-weight:700;background:#111;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer}</style></head><body>${body}</body></html>`;

module.exports = async function handler(req, res) {
  const e = req.query?.e; const s = req.query?.s;
  const send = (code, html) => { res.statusCode = code; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); };
  if (!(await verifyOptOut(e, s))) return send(400, page('Link not valid', '<p>This link is not valid. Reply to any JustBread email and Jay will sort it out.</p>'));
  const q = (on) => `?e=${encodeURIComponent(e)}&s=${encodeURIComponent(s)}${on ? '&on=1' : ''}`;
  if (req.method === 'POST') {
    const on = req.query?.on === '1';
    await setDeliveryEmails(e, on);
    return send(200, page('Saved', on
      ? '<p>Done. You\'ll get delivery notices again.</p>'
      : `<p>Done. No more delivery notices.</p><p>You'll still get emails about your orders and subscription.</p><form method="post" action="${q(true)}"><button>Turn them back on</button></form>`));
  }
  return send(200, page('Delivery notices', `<p>Stop getting "your bread is here" emails?</p><p>You'll still get emails about your orders and subscription.</p><form method="post" action="${q(false)}"><button>Turn off delivery notices</button></form>`));
};
