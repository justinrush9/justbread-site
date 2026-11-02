const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { buildSchedule } = require('../../lib/production');

// SPEC.md 9b acceptance: for the same loaf count, with the desktop app's
// done-by time set to the done time this schedule calculates from its start
// time, the two match to the minute and gram.
test('web schedule matches the desktop app exactly (1-60 loaves, three start times)', () => {
  const cases = [];
  for (const start of ['07:00', '05:30', '08:15']) {
    for (let loaves = 1; loaves <= 60; loaves++) {
      const web = buildSchedule({ loaves, startTime: start, amLoaves: loaves });
      cases.push({ loaves, start, done_secs: web.done_exact_secs, web });
    }
  }
  const desktop = JSON.parse(execFileSync('python3', [path.join(__dirname, '../compare/desktop_calc.py')], {
    input: JSON.stringify(cases.map(({ loaves, done_secs }) => ({ loaves, done_secs }))),
  }).toString());
  cases.forEach(({ loaves, start, web }, i) => {
    const d = desktop[i];
    const label = `${loaves} loaves from ${start}`;
    assert.deepEqual(web.thursday, d.thursday, label);
    assert.deepEqual(web.wednesday, d.wednesday, label);
    assert.deepEqual(web.tuesday.desktop, d.tuesday, label);
    assert.deepEqual(web.totals, d.totals, label);
    assert.equal(web.thursday.events[0][1], web.start_time, `${label}: oven on at the start time`);
  });
});

test('Tuesday buffer: AM sized for count + 2, PM recalculated, red flag when short', () => {
  const s = buildSchedule({ loaves: 26, startTime: '07:00' });
  assert.equal(s.tuesday.am_sized_for, 28);
  assert.equal(s.tuesday.pm_use, '1,083g');
  assert.equal(s.tuesday.surplus, '83g');
  assert.equal(s.tuesday.short_loaves, 0);
  const late = buildSchedule({ loaves: 31, startTime: '07:00', amLoaves: 28 });
  assert.equal(late.tuesday.short_loaves, 3);
  assert.equal(late.tuesday.surplus, null);
});

test('plan is fed by the sheet, honors a week start time, and flags orders after the AM feed', async () => {
  const { freshDb } = require('../helpers/db');
  const plan = require('../../lib/productionPlan');
  const db = await freshDb();
  const T = '2026-11-12';
  const add = (n) => db.query(`INSERT INTO orders (source, order_type, payment_status, loaves, fulfillment_type, delivery_method, pickup_location, fulfillment_date) VALUES ('stripe','onetime','paid',$1,'local','pickup','ECB',$2)`, [n, T]);
  await add(12);
  let p = await plan.planFor(T);
  assert.equal(p.loaves, 13, '12 ordered + 1 extra');
  assert.equal(p.schedule.thursday.events[0][1], '7:00 AM');
  p = await plan.markStarted(T, 'starter_am');
  assert.equal(p.started.starter_am.loaves, 15, 'sized for 13 + 2 buffer');
  assert.equal(p.schedule.tuesday.am_sized_for, 15);
  assert.deepEqual(p.changes, []);
  await add(4); // late orders: 16 ordered + 1 extra = 17, over the buffer
  p = await plan.planFor(T);
  assert.equal(p.loaves, 17);
  assert.equal(p.schedule.tuesday.short_loaves, 2);
  assert.deepEqual(p.changes.map((c) => [c.step, c.diff]), [['starter_am', 4]]);
  p = await plan.setStartTime(T, '05:30');
  assert.equal(p.schedule.thursday.events[0][1], '5:30 AM');
  assert.equal(p.start_time_overridden, true);
});
