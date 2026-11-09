/**
 * The production schedule for one Thursday, fed by the bake sheet (9b):
 * loaves = sheet to_bake (paid, expected, declined-but-delivering, manual,
 * standing; plus extras). Start time = this week's override or the default.
 * Records when a step starts and flags any change in count after it.
 */

const { query } = require('../db/client');
const { buildSheet } = require('./sheet');
const { buildSchedule } = require('./production');
const { productionConstants } = require('./settings');

const STEPS = ['starter_am', 'starter_pm', 'mix', 'bake'];
const { shiftDate } = require('./dates');

// Production days are fixed offsets from the delivery day (SPEC 7f):
// feeds 2 days before, mix 1 day before, bake on the day.
const weekday = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
const stepLabels = (delivery) => {
  const feed = weekday(shiftDate(delivery, -2));
  return { starter_am: `${feed} AM starter feed`, starter_pm: `${feed} PM starter feed`, mix: `${weekday(shiftDate(delivery, -1))} dough mix`, bake: `${weekday(delivery)} bake` };
};

async function planFor(thursday) {
  const [sheet, constants, { rows: [override] }, { rows: starts }] = await Promise.all([
    buildSheet(thursday),
    productionConstants(),
    query('SELECT * FROM week_overrides WHERE fulfillment_date = $1', [thursday]),
    query('SELECT * FROM production_starts WHERE fulfillment_date = $1', [thursday]),
  ]);
  const startTime = override?.start_time_override || constants.start_time;
  const delivery = sheet.delivery_date;
  const STEP_LABEL = stepLabels(delivery);
  const loaves = sheet.summary.to_bake;
  const am = starts.find((s) => s.step === 'starter_am');
  const schedule = loaves > 0
    ? buildSchedule({ loaves, startTime, amLoaves: am ? am.loaves : undefined, constants })
    : null;

  const changes = starts
    .filter((s) => s.loaves !== (s.step === 'starter_am' ? loaves + constants.starter_buffer : loaves))
    .map((s) => {
      const expectedAtStep = s.step === 'starter_am' ? s.loaves - constants.starter_buffer : s.loaves;
      const diff = loaves - expectedAtStep;
      return { step: s.step, label: STEP_LABEL[s.step], started_with: s.loaves, diff };
    })
    .filter((c) => c.diff !== 0);

  return {
    thursday,
    delivery_date: delivery,
    days: { feed: shiftDate(delivery, -2), mix: shiftDate(delivery, -1), bake: delivery },
    loaves,
    ordered: sheet.summary.ordered,
    extras: sheet.summary.extras,
    start_time: startTime,
    start_time_overridden: !!override?.start_time_override,
    buffer: constants.starter_buffer,
    started: Object.fromEntries(starts.map((s) => [s.step, { loaves: s.loaves, at: s.started_at }])),
    changes,
    schedule,
  };
}

async function markStarted(thursday, step) {
  if (!STEPS.includes(step)) throw new Error('unknown step');
  const plan = await planFor(thursday);
  const loaves = step === 'starter_am' ? plan.loaves + plan.buffer : plan.loaves;
  await query(
    `INSERT INTO production_starts (fulfillment_date, step, loaves) VALUES ($1, $2, $3)
     ON CONFLICT (fulfillment_date, step) DO NOTHING`,
    [thursday, step, loaves],
  );
  return planFor(thursday);
}

async function undoStarted(thursday, step) {
  await query('DELETE FROM production_starts WHERE fulfillment_date = $1 AND step = $2', [thursday, step]);
  return planFor(thursday);
}

async function setStartTime(thursday, hhmm) {
  if (hhmm != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new Error('Start time must be HH:MM');
  await query(
    `INSERT INTO week_overrides (fulfillment_date, start_time_override) VALUES ($1, $2)
     ON CONFLICT (fulfillment_date) DO UPDATE SET start_time_override = EXCLUDED.start_time_override`,
    [thursday, hhmm],
  );
  return planFor(thursday);
}

async function setDeliveryDay(thursday, date) {
  await require('./weeks').setDeliveryDate(thursday, date || null);
  return planFor(thursday);
}

module.exports = { planFor, markStarted, undoStarted, setStartTime, setDeliveryDay, STEPS };
