/**
 * Production schedule (SPEC.md 9b): a port of scheduler/justbread_scheduler.py,
 * fed by the bake sheet instead of typed-in loaf counts.
 *
 * Same recipe and timing constants and the same rounding as the desktop app.
 * The one change the spec asks for: the bake-day timeline is built FORWARD
 * from the start time (oven on, default 7:00 AM) instead of backward from a
 * done-by time. tests/unit/production.test.js checks that, given the done
 * time this computes, the desktop app's own code produces the identical
 * schedule, to the minute and gram.
 *
 * Days, for a Thursday bake: Tuesday = starter feeds, Wednesday = dough
 * (into the fridge by 2:00 PM), Thursday = bake.
 */

const DEFAULTS = {
  starter_g: 125, water_g: 243, flour_g: 350, salt_g: 12,
  bag_g: 5440, gallon_g: 3780, salt_box_g: 48 * 28.3495,
  batch: 4,
  // seconds
  covered: 18 * 60 + 15, u1: 5 * 60 + 10, u2: 5 * 60 + 10, swap: 5 * 60,
  preheat: 30 * 60, cool: (2 * 60 + 30) * 60, pack: 30 * 60,
  dough_steps: [['Mix', 0], ['Add Salt', 60], ['Fold', 80], ['Laminate 1', 100], ['Fold 1', 120], ['Laminate 2', 145],
    ['Fold 2', 160], ['Rest', 180], ['Preshape', 240], ['Shape', 330], ['-> Fridge', 390]],
  dough_min: 390,
  fridge_by: '14:00',
  start_time: '07:00',
  starter_buffer: 2,
};

// Times are seconds since midnight of their own day.
const parseHM = (s) => { const [h, m] = s.split(':').map(Number); return h * 3600 + m * 60; };

// Desktop r5: whole minutes (seconds dropped), rounded to the nearest 5,
// capped at 23:55. Minutes/5 is never exactly .5, so no tie rule matters.
function r5(secs) {
  const total = Math.floor(secs / 60);
  let m5 = Math.round(total / 5) * 5;
  if (m5 >= 24 * 60) m5 = 23 * 60 + 55;
  return m5 * 60;
}

function fmt(secs) {
  const total = Math.floor(secs / 60);
  const h = Math.floor(total / 60); const m = total % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Python round(): half to even. Used where the desktop rounds grams.
function pyRound(x) {
  const f = Math.floor(x); const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

const grams = (v) => `${pyRound(v).toLocaleString('en-US')}g`;

function supplyLine(totalG, unitG, unitName) {
  const full = Math.floor(totalG / unitG);
  const rem = pyRound(totalG % unitG);
  const totalU = Math.ceil(totalG / unitG);
  const p = (n) => `${n} ${unitName}${n !== 1 ? 's' : ''}`;
  if (rem === 0) return `${p(totalU)} (exact)`;
  if (full === 0) return `${p(totalU)} (${rem.toLocaleString('en-US')}g)`;
  return `${p(totalU)} (${p(full)} + ${rem.toLocaleString('en-US')}g)`;
}

function saltLine(totalSaltG, boxG) {
  const sFull = Math.floor(totalSaltG / boxG);
  const sRem = pyRound(totalSaltG - sFull * boxG);
  const sTotal = Math.ceil(totalSaltG / boxG);
  let s = `${sTotal} box${sTotal !== 1 ? 'es' : ''}`;
  if (sRem > 0) s += sFull ? ` (${sFull} box${sFull !== 1 ? 'es' : ''} + ${sRem}g)` : ` (${sRem}g)`;
  else s += ' (exact)';
  return `${totalSaltG}g  ->  ${s}`;
}

/**
 * @param {object} o
 *   loaves      total to bake (ordered + extras)
 *   startTime   'HH:MM' oven on, Thursday
 *   amLoaves    loaves the Tuesday AM feed was (or will be) sized for; default loaves + buffer
 *   constants   overrides of DEFAULTS
 */
function buildSchedule({ loaves, startTime, amLoaves, constants = {} }) {
  const c = { ...DEFAULTS, ...constants };
  const start = parseHM(startTime || c.start_time);
  const nB = Math.ceil(loaves / c.batch);
  const perB = c.covered + c.u1 + c.u2 + c.swap;
  const lastB = c.covered + c.u1 + c.u2;

  // Forward from oven on (exact seconds; rounding only when displayed).
  const ovenOn = start;
  const firstIn = ovenOn + c.preheat;
  const lastOut = firstIn + (nB - 1) * perB + lastB;
  const done = lastOut + c.cool + c.pack;

  const bake = [['Oven ON  (preheat)', r5(ovenOn)]];
  for (let i = 0; i < nB; i++) {
    const lo = i * c.batch + 1; const hi = Math.min((i + 1) * c.batch, loaves);
    bake.push([`Batch ${i + 1} IN  (${lo}-${hi})`, r5(firstIn + i * perB)]);
  }
  bake.push(['Packaging', r5(done - c.pack)], ['DONE', r5(done)]);

  // Dough: back-scheduled from the fixed fridge-by time on Wednesday.
  const fridge = r5(parseHM(c.fridge_by));
  const mix = r5(fridge - c.dough_min * 60);
  const dough = c.dough_steps.map(([name, off]) => [name, r5(mix + off * 60)]);

  // Starter. AM feed is sized for amLoaves (known count + buffer); the PM
  // feed is sized for the final count.
  const stl = loaves * c.starter_g;
  const am = amLoaves ?? loaves + c.starter_buffer;
  const amPull = (am * c.starter_g) / 9;   // pulled from the fridge, Tuesday AM
  const afterAm = amPull * 3;               // after the AM 1:1:1 feed
  const useAtPm = stl / 3;                  // starter needed going into the PM feed
  const short = useAtPm > afterAm + 1e-9;

  const tf = loaves * c.flour_g; const tw = loaves * c.water_g; const ts = loaves * c.salt_g;
  return {
    loaves,
    start_time: fmt(ovenOn),
    done_exact_secs: done,
    totals: {
      loaves, starter: stl,
      fridge_starter: grams(amPull),
      flour: supplyLine(tf, c.bag_g, 'bag'),
      water: supplyLine(tw, c.gallon_g, 'gallon'),
      salt: saltLine(ts, c.salt_box_g),
    },
    tuesday: {
      am_pull: grams(amPull), am_sized_for: am,
      pm_use: grams(useAtPm), pm_feed_each: grams(useAtPm), after_pm: grams(stl),
      surplus: short ? null : grams(afterAm - useAtPm),
      short_loaves: short ? loaves - am : 0,
      // desktop-equivalent lines for a feed sized exactly for `loaves`
      desktop: { pull: grams(stl / 9), after1: grams(stl / 3), total: grams(stl) },
    },
    wednesday: {
      start: fmt(mix),
      flour: supplyLine(tf, c.bag_g, 'bag'), water: supplyLine(tw, c.gallon_g, 'gallon'),
      salt: grams(ts), starter: grams(stl),
      steps: dough.map(([n, t]) => [n, fmt(t)]),
    },
    thursday: {
      batches: nB,
      done_by: fmt(r5(done)),
      events: bake.map(([n, t]) => [n, fmt(t)]),
    },
  };
}

module.exports = { buildSchedule, DEFAULTS, r5, fmt, supplyLine };
