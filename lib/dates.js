// Small date helpers on YYYY-MM-DD strings (calendar dates, no time zone).
const { shiftDate } = require('./fulfillment');

const toUtc = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const isThursday = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(toUtc(d)).getUTCDay() === 4;
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400e3);
const asDateStr = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function todayCentral(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now); // YYYY-MM-DD
}

// Thursdays in [from, to), oldest first.
function thursdaysBetween(from, to) {
  let d = from;
  while (new Date(toUtc(d)).getUTCDay() !== 4) d = shiftDate(d, 1);
  const out = [];
  for (; d < to; d = shiftDate(d, 7)) out.push(d);
  return out;
}

module.exports = { isThursday, daysBetween, asDateStr, todayCentral, thursdaysBetween, shiftDate };
