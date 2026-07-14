/**
 * One-off script: creates a "free loaf" coupon + a batch of unique,
 * single-use promotion codes for printing on business cards.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... node create-freeloaf-codes.mjs
 *
 * Each code:
 *   - Is 100% off, applied once — zeroes out the whole order total
 *     (loaf + delivery/shipping), whatever that total is.
 *   - api/checkout.js only exposes the promo code field on single-loaf
 *     orders (allow_promotion_codes: loavesInt === 1), so a code can
 *     never be used to discount a bulk order.
 *   - Works for one-time orders AND subscriptions (only the first
 *     invoice is free for subs — renewals charge full price).
 *   - Can be redeemed exactly once, then it's dead.
 *
 * Output: prints the codes and writes them to freeloaf-codes.csv
 * (gitignored — never commit real codes to the repo).
 */

import Stripe from 'stripe';
import { writeFileSync } from 'fs';

const QUANTITY = 50;
const PREFIX = 'FREELOAF-';
// Excludes visually ambiguous characters (0/O, 1/I/L) so codes are easy
// to read and type correctly off a small printed business card.
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY environment variable.');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function randomSuffix() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return s;
}

function generateUniqueCodes(count) {
  const codes = new Set();
  while (codes.size < count) {
    codes.add(PREFIX + randomSuffix());
  }
  return [...codes];
}

async function main() {
  console.log('Creating coupon: 100% off, once...');
  const coupon = await stripe.coupons.create({
    percent_off: 100,
    duration: 'once',
    name: 'Free Loaf (business card promo)',
  });
  console.log(`Coupon created: ${coupon.id}`);

  const codes = generateUniqueCodes(QUANTITY);
  const created = [];
  writeFileSync('freeloaf-codes.csv', 'code\n');

  for (const code of codes) {
    try {
      const promo = await stripe.promotionCodes.create({
        coupon: coupon.id,
        code,
        max_redemptions: 1,
      });
      created.push(promo.code);
      writeFileSync('freeloaf-codes.csv', promo.code + '\n', { flag: 'a' });
      console.log(`  ${promo.code}`);
    } catch (err) {
      console.error(`  FAILED ${code}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${created.length}/${codes.length} codes created and saved to freeloaf-codes.csv`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
