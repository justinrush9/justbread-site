/**
 * "How did you hear about us" (SPEC.md 9e). Asked once, on the
 * order-confirmed page, of first-time customers only.
 */

const { query } = require('../db/client');

const SOURCES = {
  search: 'Google / internet search',
  instagram: 'Instagram',
  friend_family: 'Friend or family',
  customer: 'Another customer',
  farmers_market: 'Farmers market',
  other: 'Other',
};

// A real, paid checkout; null otherwise.
async function paidSession(stripe, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) return null;
  let s;
  try { s = await stripe.checkout.sessions.retrieve(sessionId); } catch { return null; }
  if (!s || s.status !== 'complete' || !['paid', 'no_payment_required'].includes(s.payment_status)) return null;
  return s;
}

/** Should the page ask? First-time customers who haven't answered yet. */
async function shouldAsk(stripe, sessionId) {
  const s = await paidSession(stripe, sessionId);
  if (!s) return { ask: false };
  const { rows: [done] } = await query('SELECT 1 FROM referral_sources WHERE stripe_session_id = $1', [s.id]);
  if (done) return { ask: false };
  const email = s.customer_details?.email || null;
  if (email) {
    // Any order under this email from before this checkout (a minute of slack
    // so this checkout's own order, if the webhook already landed, doesn't count).
    const { rows: [prior] } = await query(
      `SELECT 1 FROM orders WHERE lower(customer_email) = lower($1) AND created_at < to_timestamp($2) - INTERVAL '1 minute' LIMIT 1`,
      [email, s.created],
    );
    if (prior) return { ask: false };
  }
  return { ask: true, choices: Object.entries(SOURCES).map(([value, label]) => ({ value, label })) };
}

async function record(stripe, sessionId, source, otherText) {
  if (!SOURCES[source]) throw new Error('Unknown choice');
  const s = await paidSession(stripe, sessionId);
  if (!s) throw new Error('Order not found');
  const other = source === 'other' && otherText ? String(otherText).trim().slice(0, 200) || null : null;
  await query(
    `INSERT INTO referral_sources (stripe_session_id, customer_email, source, other_text) VALUES ($1, $2, $3, $4)
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    [s.id, s.customer_details?.email || null, source, other],
  );
  return { saved: true };
}

async function summary() {
  const [{ rows: counts }, { rows: recent }] = await Promise.all([
    query(`SELECT source, count(*)::int AS all_time,
                  count(*) FILTER (WHERE created_at > now() - INTERVAL '90 days')::int AS last_90
           FROM referral_sources GROUP BY source`),
    query(`SELECT r.source, r.other_text, r.created_at, r.customer_email,
                  (SELECT customer_name FROM orders o WHERE lower(o.customer_email) = lower(r.customer_email) AND o.customer_name IS NOT NULL ORDER BY o.id LIMIT 1) AS customer_name
           FROM referral_sources r ORDER BY r.created_at DESC LIMIT 50`),
  ]);
  const by = Object.fromEntries(counts.map((c) => [c.source, c]));
  return {
    counts: Object.entries(SOURCES).map(([value, label]) => ({ value, label, last_90: by[value]?.last_90 || 0, all_time: by[value]?.all_time || 0 })),
    recent: recent.map((r) => ({ ...r, label: SOURCES[r.source] || r.source })),
  };
}

module.exports = { SOURCES, shouldAsk, record, summary };
