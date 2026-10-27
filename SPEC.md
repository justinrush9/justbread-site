# JustBread Order System: Spec

> **This file is the source of truth for the order and delivery system.**
> Change this spec first, then the code. If code and spec disagree, the spec
> wins until Jay says otherwise. Every feature below has acceptance criteria;
> a feature is done only when all of them pass.
>
> Status legend: **[DONE]** built and live, **[BUILT]** code exists but not
> switched on, **[TODO]** not built, **[OPEN]** waiting on a decision.

Last updated: 2026-10-27

---

## 1. Purpose

Replace the hand-kept weekly spreadsheet. Every Thursday, Jay should be able to
open one screen and see exactly what to bake, where every loaf goes, and who
needs attention, without cross-checking Stripe or his email.

## 2. Core rules

These are decided. Everything else in this spec follows from them.

1. **The payment is primary.** A payment creates the order; the order
   determines the delivery. Nothing is scheduled that hasn't been paid for,
   except manual and standing orders (section 6), which Jay enters himself.
2. **One payment = one delivery.** Billing cadence and delivery cadence always
   match: weekly pays weekly, every-other-week pays every two weeks, monthly
   pays monthly (one delivery per month), one-time pays once. No plan bills on
   one cadence and delivers on another.
3. **Everything is delivered Thursday.** Local delivery, pickup points, and
   shipping (ships Thursday via UPS Ground, arrives Friday).
4. **Cutoff: Tuesday 12:00 PM Central.** A payment at or before the cutoff goes
   on that week's Thursday; after it, the next Thursday. Jay handles capacity
   edge cases by hand. (Implemented in `lib/fulfillment.js`.)
5. **Subscription renewals bill Monday morning.** So every renewal lands before
   the cutoff and pays for that same week's Thursday. See section 4.
6. **A declined payment still appears on the sheet, flagged.** Jay decides
   whether to deliver, retry, or contact the customer.

## 3. Prerequisites (infrastructure)

| Item | Status | Notes |
|---|---|---|
| Postgres (Neon via Vercel), `orders` table, Stripe webhook | [DONE] | Live since Sep 15 2026 |
| Delivery method / address / fulfillment date migration | [BUILT] | In `db/schema.sql`; never run against the live DB |
| `CRON_SECRET` env var for the daily Stripe reconcile | [TODO] | Without it the daily catch-up sweep doesn't run |
| Legacy $35/mo every-other-week subs moved to current prices | Partly done | Jessica and Toni still pending; see CLAUDE.md |

**Acceptance:** after the migration and backfill, every paid order since Oct 21
2026 has a `delivery_method` and a `fulfillment_date`, and a manual "Sync from
Stripe" adds nothing new (meaning the webhook missed nothing).

## 4. Billing timing [TODO]

**Problem:** renewals currently fall on whatever weekday the subscription was
last reset (all existing subs: Wednesday, after the Oct 21 restart). A
Wednesday renewal pays for the next day's loaf, but the cutoff rule files it a
week later, so the sheet runs a week behind.

**Rule:** every subscription renews Monday early morning (Central).

- **Existing subscriptions:** after their current paid period, move each one's
  next renewal to the Monday before its next delivery (weekly: the next
  Monday; every-other-week: the Monday of their next delivery week). No double
  charge, no skipped week. Done once, by hand, through Stripe.
- **New subscriptions: charged at signup.** The signup payment pays for the
  first delivery (that week's Thursday if before the cutoff, otherwise the
  next). Charging up front means nobody can subscribe and cancel before
  paying. The **first renewal** is the Monday of the *next* delivery week
  (one week after the first delivery for weekly, two for every-other-week),
  and every renewal after that is a Monday. This must never charge twice for
  the same Thursday (e.g. a Saturday signup must not also be charged two days
  later on Monday). Exact Stripe mechanism (billing anchor vs. trial period)
  to be confirmed against Stripe's docs at build time. (Decided 2026-10-27.)
- **Monthly:** renews monthly on a Monday-anchored date, one delivery per
  charge.

**Acceptance:** for every active subscription, Stripe's next renewal date is a
Monday, and that renewal's order lands on the Thursday of the same week.

## 5. Payment events

The webhook (`api/webhook.js`) and the daily reconcile (`api/reconcile.js`)
share one implementation in `lib/orderProcessing.js`. They handle:

| Stripe event | Effect | Status |
|---|---|---|
| `checkout.session.completed` | One-time order row, `payment_status = paid` | [DONE] |
| `invoice.paid` | Subscription order row, `payment_status = paid` | [DONE] |
| `invoice.payment_failed` | Order row for that delivery, `payment_status = declined` | [TODO] |
| `invoice.paid` after a decline (retry succeeds) | Same row flips to `paid`; the flag clears automatically | [TODO] |

One invoice produces at most one order row, whether it first arrives as failed
or paid. The webhook endpoint must be subscribed to `invoice.payment_failed`
(uses the `www.` URL; see CLAUDE.md gotcha).

**Acceptance:** a renewal with a declined card shows on that Thursday's sheet
with a red Declined tag; if Stripe's retry later succeeds, the same entry turns
paid without creating a second row.

## 6. Orders Jay enters himself [TODO]

Both kinds are entered from the admin app, are $0 in the system, never touch
Stripe, and are excluded from sales totals.

### 6a. One-time manual order
For people who contact Jay directly.

Fields: name, loaves, delivery method (local delivery, pickup point, or
shipped), address (required for local delivery and shipped), pickup point
(required for pickup), email (optional), phone (optional), Thursday it goes
on, paid/unpaid, note.

### 6b. Standing order (barter)
Recurring arrangements, e.g. "2 loaves to the coffee shop every week."

Fields: everything in 6a, plus frequency (every week or every other week),
start date, optional end date.

Behavior:
- Appears automatically on every matching Thursday from the start date until
  the end date or until Jay ends it.
- Jay can **skip a single week** without ending it.
- Jay can **pause** and **resume** it.
- Every-other-week standing orders alternate from their start date.

**Acceptance:** a weekly standing order created today appears on every
Thursday sheet from its start date on; skipping one week removes it from only
that Thursday; ending it removes it from all later Thursdays and none earlier.

## 7. Bake sheet [Partly DONE]

One screen per Thursday. Jay picks the Thursday (defaults to the next upcoming
one with orders).

### 7a. Summary (top of screen)
- **Total loaves**
- Loaves for **local delivery**, **pickup**, and **shipping**
- **Delivery stops:** one per unique local delivery address, plus one per
  pickup point that has orders, plus **one** for all shipping combined (all
  shipped loaves go out at a single UPS stop). Two orders to the same address
  are one stop.
- Count of **declined** orders, and count of **manual / standing** orders

### 7b. Each order entry shows
- Customer name and loaf count
- Source tag: **Subscription**, **One-time**, **Manual**, or **Barter**
- **Declined** tag when the payment failed, with a "resolved" action that
  clears the flag once Jay has handled it
- 📍 **Map** link: opens the delivery address in Google Maps. The address
  itself is **not** displayed. (Local delivery only. Pickup entries show the
  pickup point name.)
- **Shipped entries show the full address**, laid out so it can be copied
  straight into Pirate Ship (with a one-tap copy button), until shipping is
  automated.
- ✉️ **Email** link: opens a new email to the customer (when an email exists)
- 📞 **Call / Text** links (only when a phone number exists)
- Note, if one was entered
- ✓ **Delivered** checkbox, tapped as each stop is completed; saved, so it
  survives closing the app. The summary shows stops done vs. total.

### 7c. Grouping and order
Grouped by delivery method: Local Delivery, Pickup (sub-grouped by pickup
point with subtotals), Shipped. Local delivery entries are listed in route
order (section 8).

### 7d. Print
A print button producing a clean one-page bake-day sheet. [DONE, to be
updated for the new fields]

**Acceptance:** for a Thursday with known orders, the summary numbers match a
hand count; every local delivery entry's Map link opens the right address;
no full street address is visible for local delivery entries; shipped
entries show a copyable full address.

## 8. Delivery route [TODO]

- **Start and end at home**, every time. Home address is stored as a setting
  (not hard-coded).
- **Stops are ordered by Google route optimization** (Routes API,
  `optimizeWaypointOrder`), from home, through every local delivery address
  and pickup point for that Thursday, back home. The local delivery list on
  the sheet is shown in that optimized order.
- The optimized order is computed **once per Thursday** and stored; it is only
  recomputed when Jay taps "Re-optimize" or the stop list changes. Opening the
  sheet does not call Google.
- **Primary flow: stop by stop.** Stops are listed numbered (1, 2, 3, ...) in
  the optimized order. Each stop has a **Navigate** button that opens the
  Google Maps app directly (not a browser page) with driving directions from
  wherever Jay is to that stop.
- **One tap per stop:** a **"Delivered, next stop"** button ticks ✓ on the
  current stop and immediately opens Maps to the next one. The next
  undelivered stop is highlighted and scrolled into view whenever Jay returns
  to the app.
- Returning from Maps must land exactly where Jay left off (same Thursday,
  same scroll position, checkboxes intact), with no reload or re-login.
- After the last stop, Navigate goes home.
- **Secondary: "View whole route"** opens Google Maps with every stop loaded
  in the optimized order, for an overview before leaving or for following the
  whole loop in Maps. If the stops exceed what one Google Maps link can hold,
  it is split into consecutive legs, each its own button.
- The UPS shipping stop is not part of the drive route unless Jay adds it.

**Cost guardrails (required):**
- The Google API key lives only on the server (Vercel env var), never in the
  browser, and is restricted to the Routes API.
- A hard **daily request quota** of **150 requests/day** set in Google Cloud.
  Sized so the absolute worst case (a bug hitting the cap every day for a
  month = 4,500) still stays inside Google's 5,000 free requests/month.
  Normal use is a few requests a week. One request optimizes a whole route,
  so request volume does not grow with the number of customers.
- **The app counts its own Google calls** and stops itself at 150/day, as a
  second layer under Google's quota.
- **If optimization is unavailable** (daily cap reached, Google error, or more
  stops than one request can optimize), the sheet shows a clear red notice
  saying why, and falls back to ordering stops by zip and street so the route
  still works. It never fails silently.
- The bake sheet shows a small usage line (e.g. "Route optimizations this
  month: 6 of 5,000 free").
- **Stop limit:** Google caps how many stops one optimization request can
  handle. Confirm the exact number at build time. If a Thursday ever exceeds
  it, the sheet says so in advance (when the stop count passes the limit, not
  on the morning of delivery), and the route is optimized in two halves.
- A Google Cloud **budget alert** at $5/month.
- Expected cost at Jay's volume: $0 (well inside Google's monthly free
  usage; see change log for the pricing checked).

**Acceptance:** on Jay's phone, with the app installed: stops appear in the
order Google's optimization returned; Navigate opens the Maps app with
directions to that stop; "Delivered, next stop" checks the stop off and opens
Maps to the next one; switching back to the app shows the next stop
highlighted with all checkmarks kept; "View whole route" shows the full loop
from home back to home.

## 9. App form [TODO]

The admin pages (orders, bake sheet, add order, standing orders) become an
**installable web app** (PWA): added to the phone home screen once, then opens
full screen with its own icon. Same code and hosting as the site; no app
store. Must be usable one-handed on a phone at the delivery stops (large tap
targets, no horizontal scrolling).

Not needed: offline mode, a native iOS/Android app.

**Acceptance:** on Jay's phone, "Add to Home Screen" produces a JustBread icon
that opens the bake sheet full screen, still behind the admin password.

## 9b. Production schedule [TODO]

The weekly production scheduler (today a separate desktop app,
`scheduler/justbread_scheduler.py`) moves into this app and is **fed by the
orders**, instead of Jay typing loaf counts in by hand.

- **Input:** total loaves for each Thursday, taken from the bake sheet
  (all paid, declined-but-delivering, manual, and standing orders), plus
  extras (below), plus the bake **start time**.
- **Extras, baker's dozen:** 1 extra loaf for every 12 ordered, i.e.
  `floor(ordered / 12)` (12 ordered -> 13 baked, 25 ordered -> 27 baked,
  11 ordered -> 11 baked). Shown separately from orders on the schedule and
  bake sheet ("24 ordered + 2 extra = 26 to bake"). Jay can override the
  extra count for a given week.
- **Start time:** the schedule is built **forward from when Jay starts on
  bake day** (Thursday), not backward from a finish time. Default **7:00 AM**
  (oven on), stored as a setting; Jay can change it for any single week
  without changing the default. Packaging and "done" times are calculated
  from it and shown on the schedule.
- **Starter feed before the cutoff (D5 decided: buffer):** the Tuesday
  early-morning starter work is sized for the loaves known at that moment
  (orders + baker's dozen extras) **plus a buffer** of 2 loaves (a setting,
  editable). At the Tuesday PM feed, after the noon cutoff, the schedule
  recalculates for the final count and tells Jay the exact amounts to use.
  Any buffer starter left unused is just shown as surplus; if late orders
  exceed the buffer, the schedule flags it in red.
- **Output (same as the desktop app today):** a day-by-day schedule for the
  week: starter pull and feeds, dough timeline (mix, salt, folds, laminations,
  rest, preshape, shape, into fridge), bake timeline (oven on, each batch of
  4 in, packaging, done), and a shopping/supply list (flour bags, water
  gallons, salt boxes, starter grams).
- **All recipe and timing math is ported unchanged** from the desktop app:
  125g starter, 350g flour, 243g water, 12g salt per loaf; batches of 4;
  dough steps and oven timings as in the current constants; dough into the
  fridge by 2:00 PM the day before bake. These constants live in one
  settings place, editable by Jay, not scattered through code.
- The schedule **updates automatically** when orders change. Once a
  production step has started, the schedule shows the count it started with
  and flags any later change (e.g. "2 orders arrived after the starter feed").
- Printable, like the desktop app's PDF.
- The desktop app stays as the fallback until this one is proven.

**Acceptance:** for the same loaf count, with the desktop app's done-by time
set to the done time this schedule calculates from its start time, the two
match to the minute and gram. The extras and buffer math matches the
examples above.

## 10. Open decisions

| # | Question | Options | Default if undecided |
|---|---|---|---|
| (none open) | | | |

## 11. Later (not in this phase)

- Customer emails: order confirmation with delivery date, day-before reminder
- Customer-facing view in `/manage`: next delivery and next charge date
- Calendar feed (.ics) of delivery days for Jay's own calendar
- Bake-to-order linking (`bakes` table, still unused)
- **Shipping automation.** Jay ships with **Pirate Ship**, always **UPS
  Ground**, with preset package dimensions and weights for each order size.
  Goal: shipped orders on a Thursday produce ready-to-buy labels in Pirate
  Ship without retyping addresses. Needs: Jay's preset table (loaves ->
  box dimensions + weight), and research into what Pirate Ship accepts
  (API vs. spreadsheet import).

## 12. Data model changes (for the build)

`orders` table additions:
- `source` TEXT: `stripe` | `manual` | `standing`
- `payment_status` TEXT: `paid` | `declined` | `unpaid` (manual) | `n/a` (barter)
- `declined_resolved_at` TIMESTAMPTZ
- `customer_phone` TEXT
- `note` TEXT
- `standing_order_id` INTEGER, references `standing_orders`
- `stripe_invoice_id` TEXT, unique when present (one row per invoice; how a
  failed-then-paid invoice updates its own row)
- `stripe_event_id` and `stripe_customer_id` become nullable (manual and
  standing orders have neither)

New `standing_orders` table: name, contact fields, loaves, delivery method,
address / pickup point, frequency, start date, end date, paused flag, note.

New `standing_order_skips` table: standing order id + skipped Thursday.

Standing order entries are generated for a Thursday when that sheet is viewed
or by the daily cron, whichever comes first; generation is idempotent (one
entry per standing order per Thursday).

## 13. Change log

- 2026-10-27: Decided D5 (keep Tuesday-noon cutoff; size the early starter
  work with a 2-loaf buffer, recalculate at the PM feed), D6 (baker's dozen:
  floor(ordered/12) extras, overridable per week), D7 (schedule built forward
  from a bake-day start time, default 7:00 AM, editable per week).
- 2026-10-27: Added 9b, production schedule fed by orders (port of the
  desktop scheduler). Open: D5 (cutoff vs. starter timing), D6 (extra
  loaves), D7 (done-by time).
- 2026-10-27: Route flow decided: stop by stop (Navigate per stop, "Delivered,
  next stop" one-tap), with "View whole route" as a secondary overview.
- 2026-10-27: Route guardrails: daily cap 150 (worst case stays free),
  app-side counter, visible notice + zip/street fallback when optimization is
  unavailable, monthly usage line, advance warning if stops exceed Google's
  per-request limit.
- 2026-10-27: Decided D1 (route starts and ends at home), D2 (delivered
  checkbox: yes), D3 (stops ordered by Google route optimization). Shipped
  entries show the full, copyable address for Pirate Ship. Pricing checked:
  Google's optimized route requests bill under Compute Routes Pro, $10 per
  1,000 requests with 5,000 free per month, so ~1 to 5 requests a week costs
  nothing.
- 2026-10-27: D4 decided: new subscribers are charged at signup; first
  renewal is the Monday of the next delivery week. Shipping automation
  (Pirate Ship, UPS Ground, preset box sizes) added to Later.
- 2026-10-27: Spec created from design discussion (core rules, declined
  handling, manual and standing orders, bake sheet summary and entries, route,
  PWA, open decisions D1 to D4).
