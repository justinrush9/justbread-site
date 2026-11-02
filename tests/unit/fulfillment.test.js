const test = require('node:test');
const assert = require('node:assert');
const { computeFulfillmentDate, computeRenewalFulfillmentDate } = require('../../lib/fulfillment');

// November 2026 is Central Standard Time (UTC-6).
const ct = (local) => new Date(`${local}-06:00`);

test('new payments: Tuesday noon cutoff (core rule 4)', () => {
  assert.equal(computeFulfillmentDate(ct('2026-11-09T09:00:00'), 'local_delivery'), '2026-11-12'); // Mon
  assert.equal(computeFulfillmentDate(ct('2026-11-10T12:00:00'), 'local_delivery'), '2026-11-12'); // Tue noon exactly
  assert.equal(computeFulfillmentDate(ct('2026-11-10T12:01:00'), 'local_delivery'), '2026-11-19'); // Tue 12:01
  assert.equal(computeFulfillmentDate(ct('2026-11-14T10:00:00'), 'pickup'), '2026-11-19');         // Sat
});

test('renewals: charge by Thursday noon -> that Thursday (core rule 5)', () => {
  const cases = [
    ['2026-11-09T06:00:00', '2026-11-12'], // Monday 6 AM renewal
    ['2026-11-11T10:00:00', '2026-11-12'], // monthly renewal on a Wednesday
    ['2026-11-12T11:59:00', '2026-11-12'], // Thursday 11:59
    ['2026-11-12T12:00:00', '2026-11-12'], // Thursday noon exactly
    ['2026-11-12T12:01:00', '2026-11-19'], // Thursday 12:01
    ['2026-11-14T08:00:00', '2026-11-19'], // Saturday
    ['2026-11-15T23:59:00', '2026-11-19'], // Sunday night
    ['2026-12-31T09:00:00', '2026-12-31'], // Thursday across a year end
    ['2027-01-03T09:00:00', '2027-01-07'], // Sunday after New Year
  ];
  for (const [at, want] of cases) assert.equal(computeRenewalFulfillmentDate(ct(at)), want, at);
});

test('renewal rule uses Central time, not UTC', () => {
  // Thursday 1:00 PM Central = 19:00Z: past the cutoff even though it is
  // "before 12 PM" nowhere in UTC terms that would matter.
  assert.equal(computeRenewalFulfillmentDate(new Date('2026-11-12T19:00:00Z')), '2026-11-19');
  // Sunday 11 PM Central is Monday 05:00Z; still Sunday locally -> next Thu.
  assert.equal(computeRenewalFulfillmentDate(new Date('2026-11-16T05:00:00Z')), '2026-11-19');
});
