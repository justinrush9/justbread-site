/**
 * Fulfillment-date cutoff rule.
 *
 * Cutoff: Tuesday 12:00 PM America/Chicago. Orders placed at or before that
 * moment target that same week's bake; orders placed after roll to the
 * following week. Jay handles capacity edge cases (e.g. a huge order right
 * at the wire) manually rather than this being automated.
 *
 * Day assignment within the target week (per CLAUDE.md's delivery schedule):
 *   shipped        -> Wednesday (ships UPS Ground, arrives Thursday)
 *   local_delivery -> Friday
 *   pickup         -> Friday (ASSUMPTION: dropped at pickup points on the
 *                     same run as local delivery — confirm with Jay; if any
 *                     drop point runs on a different day, split it out below
 *                     instead of a single flat offset)
 *
 * All math is done on Chicago *calendar* dates (Y-M-D), not instants, so DST
 * transitions never change which day an order lands on.
 */

const TZ = 'America/Chicago';

// Mon=0 ... Sun=6
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// Days after that week's Tuesday.
const OFFSET_FROM_TUESDAY = {
  shipped: 1,         // Wed
  local_delivery: 3,  // Fri
  pickup: 3,           // Fri — see ASSUMPTION above
};

function chicagoParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl can print midnight as "24" with hour12:false in some environments.
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday, // 'Mon'..'Sun'
  };
}

function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function toDateString({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @param {Date|string|number} orderCreatedAt - when the order/invoice was created
 * @param {'shipped'|'local_delivery'|'pickup'} deliveryMethod
 * @returns {string|null} YYYY-MM-DD, or null for an unrecognized delivery method
 */
function computeFulfillmentDate(orderCreatedAt, deliveryMethod) {
  const offset = OFFSET_FROM_TUESDAY[deliveryMethod];
  if (offset === undefined) return null;

  const when = orderCreatedAt instanceof Date ? orderCreatedAt : new Date(orderCreatedAt);
  const p = chicagoParts(when);
  const dow = WEEKDAY_INDEX[p.weekday]; // Mon=0..Sun=6

  // Days to walk from the order's date to *that week's* Tuesday.
  const deltaToTuesday = 1 - dow;
  let tuesday = addDays(p.year, p.month, p.day, deltaToTuesday);

  // Past the cutoff if it's Wed–Sun, or Tuesday after 12:00 PM exactly.
  const pastCutoff = dow > 1 || (dow === 1 && (p.hour > 12 || (p.hour === 12 && p.minute > 0)));
  if (pastCutoff) {
    tuesday = addDays(tuesday.year, tuesday.month, tuesday.day, 7);
  }

  const target = addDays(tuesday.year, tuesday.month, tuesday.day, offset);
  return toDateString(target);
}

module.exports = { computeFulfillmentDate, OFFSET_FROM_TUESDAY };
