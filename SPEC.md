# JustBread Order System: Spec

> **This file is the source of truth for the order and delivery system.**
> Change this spec first, then the code. If code and spec disagree, the spec
> wins until Jay says otherwise. Every feature below has acceptance criteria;
> a feature is done only when all of them pass.
>
> Status legend: **[DONE]** built and live, **[BUILT]** code exists but not
> switched on, **[TODO]** not built, **[OPEN]** waiting on a decision.

Last updated: 2026-10-30

---

## 1. Purpose

Replace the hand-kept weekly spreadsheet. Every Thursday, Jay should be able to
open one screen and see exactly what to bake, where every loaf goes, and who
needs attention, without cross-checking Stripe or his email.

This is a new build. The database is not in use today; it goes live on a
chosen Monday (section 3) and starts empty from that date.

## 2. Core rules

These are decided. Everything else in this spec follows from them.

1. **The payment is primary.** A payment creates the order; the order
   determines the delivery. Nothing is scheduled that hasn't been paid for,
   except manual and standing orders (section 6), which Jay enters himself,
   and expected renewals (rule 5), which are known in advance.
2. **One payment = one delivery.** Billing cadence and delivery cadence always
   match: weekly pays weekly, every-other-week pays every two weeks, monthly
   pays monthly (one delivery per month), one-time pays once. No plan bills on
   one cadence and delivers on another.
3. **Everything is delivered Thursday.** Local delivery, pickup points, and
   shipping (ships Thursday via UPS Ground, arrives Friday).
4. **New payments: cutoff Tuesday 12:00 PM Central.** A one-time order or a
   new subscription's first payment at or before the cutoff goes on that
   week's Thursday; after it, the next Thursday. Jay handles capacity edge
   cases by hand. (Implemented in `lib/fulfillment.js`.)
5. **Renewals: delivered the Thursday of the week they charge, if they charge
   by Thursday 12:00 PM Central.** A renewal's date is set by Stripe weeks in
   advance, so the system knows it's coming and counts it before the charge
   happens (an "expected" entry, section 4c). A renewal due Monday through
   Thursday noon goes on that week's Thursday; one due Thursday after noon
   through Sunday goes on the next Thursday.
6. **Weekly and every-other-week renewals charge Monday morning** (6:00 AM
   Central), so the money is in hand, and declines and cancellations are
   known, before the Tuesday starter work begins. See section 4a.
7. **Monthly renewals keep their calendar date** (e.g. the 9th of every
   month), whatever weekday it falls on. Rule 5 places them. See section 4b.
8. **A declined payment still appears on the sheet, flagged.** Jay decides
   whether to deliver, retry, or contact the customer.
9. **Stripe write scope (exception to the CLAUDE.md safety contract).** The
   app may change existing subscriptions only in these ways:
   - set `trial_end` (with `proration_behavior: none`) to move the next
     renewal date (sections 4a and 4b). "Trial" is only Stripe's name for
     "don't bill again until this date." Nobody gets a free delivery;
   - set or clear `pause_collection` to skip or resume deliveries
     (section 6d).

   Nothing else: never prices, items, quantities, customers, or
   cancellation/deletion. Refunds are done by Jay in Stripe and synced back
   (section 5).
10. **Anything that writes to Stripe is proven first** in Stripe test mode
    with test clocks, covering the cases listed in its section, before it
    runs against live data.

## 3. Go-live (infrastructure)

| Item | Status | Notes |
|---|---|---|
| Postgres (Neon via Vercel), `orders` table, Stripe webhook | [BUILT] | Exists, but the database is not in use |
| Schema in section 12 applied | [TODO] | Run once at go-live |
| `CRON_SECRET` env var | [TODO] | Without it the daily cron (reconcile, standing-order freeze, renewal sync) doesn't run |
| Webhook endpoint enabled and subscribed to every event in sections 5 and 9c | [TODO] | `www.` URL (see CLAUDE.md). The endpoint currently receives events but its inserts fail on missing columns; Stripe may disable it after repeated failures, so check it's enabled at go-live |
| Stripe failed payments: **Manage failed payments → Card payments → Manage**: custom retry schedule finishing within 5 days (e.g. retry 1, 3, and 5 days after the first failure); **"If all retries for a payment fail: cancel the subscription"** | [TODO] | Jay, in Dashboard → Settings → Billing → Subscriptions and emails. A weekly sub declined Monday is cancelled by Saturday, before the next Monday renewal can create a second invoice |
| Stripe customer emails | [TODO] | ON: expiring cards, card payment failures, hosted link for payments needing confirmation. OFF: trial-ending reminder and "trial over" statement message (`trial_end` is only used to set renewal dates, rule 9), upcoming-renewal emails (weekly subscribers would get one every week; section 9d covers this) |
| Stripe billing mode | Decided | Classic. The site's Stripe library pins an API version older than 2025-09-30, so API-created subscriptions are classic. Test clocks (rule 10) run in classic mode; changing modes or upgrading the Stripe library means re-running them |
| Legacy $35/mo every-other-week subs moved to current prices | Partly done | Jessica and Toni still pending; see CLAUDE.md |

**Go-live date:** a Monday Jay picks. Payments before it are not imported.

**Acceptance:** from the go-live date on, every Stripe payment has an order
row, and a manual "Sync from Stripe" adds nothing new (the webhook missed
nothing).

## 4. Billing timing and renewals [TODO]

### 4a. Weekly and every-other-week: Monday renewals

**Existing subscriptions** (renew Wednesdays today, after the Oct 21 restart):
1. **Jay emails subscribers first**, telling each one their switchover date
   and that nothing changes about price or delivery day. (Claude drafts.)
2. On or after the notice, each subscription's next renewal is moved to its
   switchover Monday, 6:00 AM Central, with `trial_end` and no proration.
   Weekly: the first Monday after their last Wednesday charge. Every other
   week: the Monday of their next delivery week. No double charge for any
   Thursday, no skipped Thursday.
3. Done once, by a script Jay reviews. The per-subscription table
   (customer, cadence, last charge, switchover Monday, Thursday it pays for)
   is written into this section before the script runs.

**New subscriptions: charged at signup.** Checkout charges the first delivery
in full, as it does today (that week's Thursday if before the Tuesday
cutoff, otherwise the next). When that first payment arrives
(`invoice.paid`, `billing_reason = subscription_create`), the webhook sets
`trial_end` to the Monday of the *next* delivery week, 6:00 AM Central (one
week after the first delivery for weekly, two for every-other-week). Every
renewal after that is a Monday.

- Must never charge twice for the same Thursday.
- Stripe shows these subscriptions as `trialing` until the first Monday. All
  code treats `trialing` the same as `active`.
- Renewal times are stored as timestamps, so they shift an hour with
  daylight saving (5:00 or 7:00 AM). Both are still before the cutoff; no
  correction needed.

**Test clock cases (rule 10):** signups on Monday 9 AM, Tuesday 11:59 AM,
Tuesday 12:01 PM, and Saturday, for weekly and every-other-week. For each:
one charge per Thursday, first renewal on the right Monday. Also check what
the customer portal and Stripe receipts say during the `trialing` window; if
it reads as a free trial to a customer, stop and revisit before going live.

**Acceptance:** for every active weekly and every-other-week subscription,
Stripe's next renewal is a Monday, and that renewal lands on the Thursday of
the same week.

### 4b. Monthly

No change to billing. Monthly subscriptions renew on their calendar date,
and rule 5 places each renewal. Worst case, a renewal due Thursday afternoon
is delivered 7 days later; most are 0 to 3 days. New monthly signups follow
the Tuesday cutoff for their first delivery (rule 4), like any new payment.

### 4c. Expected renewals

- The app keeps each subscription's **next renewal time** from Stripe
  (section 12, `subscriptions`), updated by webhook and by the daily cron.
- Any renewal that rule 5 places on a Thursday shows on that Thursday's
  sheet and production schedule **before it charges**, tagged
  **Expected (charges Wed)**.
- When it charges, the expected entry becomes the paid order: one entry, no
  duplicate.
- If it declines, it stays, tagged Declined (rule 8).
- If the subscription is cancelled, paused, or skipped before the charge,
  the expected entry disappears (or shows greyed as **Skipped**; see 6d).
- **Placing a renewal:** an invoice with `billing_reason = subscription_cycle`
  is placed by rule 5 using the renewal's scheduled time. Every other paid
  invoice (first payment, a resume or anchor change that charges) is placed
  by rule 4.

**Acceptance:** a monthly renewal due Wednesday shows as Expected on that
Thursday's sheet on the Monday before, counts in the Tuesday starter
numbers, and turns into one paid entry when Stripe charges it.

## 5. Payment events

The webhook (`api/webhook.js`) and the daily reconcile (`api/reconcile.js`)
share one implementation in `lib/orderProcessing.js`. They handle:

| Stripe event | Effect | Status |
|---|---|---|
| `checkout.session.completed` | One-time order row, `payment_status = paid` | [BUILT] |
| `invoice.paid` | Subscription order row, `payment_status = paid`, placed per 4c | [BUILT], placement [TODO] |
| `invoice.payment_failed` | Order row for that delivery, `payment_status = declined` | [TODO] |
| `invoice.paid` after a decline (retry succeeds) | Same row flips to `paid`; the flag clears automatically | [TODO] |
| `charge.refunded`, full refund | Order marked `refunded`: off the sheet, out of loaf and sales totals, alert raised | [TODO] |
| `charge.refunded`, partial | Order stays, flagged "Partly refunded $X"; Jay adjusts loaves by hand if needed (6c) | [TODO] |
| `customer.subscription.created/updated/deleted` | Updates the `subscriptions` mirror (next renewal, pause, scheduled cancel, ended) | [TODO] |

Rules:
- One invoice produces at most one order row (`stripe_invoice_id` unique),
  whether it first arrives as failed or paid.
- The reconcile can replay events out of order, so: a `paid` row never goes
  back to `declined`; a `refunded` row never goes back to `paid`.
- `fulfillment_date` is set once, when the row is created, and never
  recalculated when a retry later succeeds.
- **When Stripe gives up on retries** and cancels the subscription: the
  declined entries keep their Declined tag, the subscription is marked ended
  ("after failed payment"), an alert is raised, it appears under
  Cancellations (9c), and no further expected entries are created.

**Acceptance:** a renewal with a declined card shows on its Thursday with a
red Declined tag; if Stripe's retry later succeeds, the same entry turns paid
without creating a second row. A full refund removes the order from the
sheet and totals.

## 6. Orders and subscriptions Jay manages [TODO]

Manual and standing orders are entered from the admin app, are $0 in the
system, never touch Stripe, and are excluded from sales totals and from the
`/admin` payment log.

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
- **Future Thursdays are calculated, not stored.** Each sheet and schedule
  works out its standing orders from the current rules, so editing a standing
  order (loaves, address, frequency) changes every future Thursday at once,
  and nothing can go out of date. A row is stored only when something happens
  to one Thursday (skipped, delivered, note added), and every past Thursday is
  frozen by the daily cron with the values it had, so later edits never
  rewrite history.

**Acceptance:** a weekly standing order created today appears on every
Thursday sheet from its start date on; skipping one week removes it from only
that Thursday; ending it removes it from all later Thursdays and none earlier;
changing its loaves from 2 to 3 changes every future Thursday and no past one.
**Automated tests** (fixed dates, run before every deploy that touches this
logic): weekly, every-other-week alternation across a month boundary, skip,
pause and resume, end date, an edit partway through, and a past Thursday
staying frozen after an edit.

### 6c. Editing a single order
For any order on a sheet (Stripe, manual, or standing):
- **Move** it to another Thursday
- **Change its loaves** for that delivery only
- **Cancel** that delivery (removes it from the sheet and counts). For a paid
  Stripe order this does not refund; Jay refunds in Stripe and section 5
  syncs it.
- **Edit** address, phone, or note

Every change is kept in the order's history (what changed, old value, when).
Edits never write to Stripe.

### 6d. Subscription controls (writes to Stripe, rule 9)
From a subscriber's entry or a Subscribers screen:
- **Skip this week:** no charge and no delivery for one upcoming Thursday.
- **Skip until [date]:** no charges or deliveries until that date.
- **Resume:** ends a skip or pause early.

Implemented with `pause_collection` (`behavior: void`, `resumes_at` set past
the skipped renewal); resume clears it. A skip only applies to renewals that
haven't charged yet. If that Thursday is already paid, the button says so and
offers cancel-this-delivery (6c) plus a refund in Stripe. Skipped Thursdays
show greyed as **Skipped** and don't count.

Changes Jay makes directly in Stripe, or customers make in the portal, sync
back through `customer.subscription.updated` and look the same in the app.

**Test clock cases (rule 10):** skip one week for weekly and every-other-week
(no charge that Monday, normal charge the next due Monday, anchor unchanged);
skip until a date three weeks out; resume early; a monthly skip.

**Acceptance:** tapping Skip this week on a weekly subscriber produces no
charge that Monday, shows Skipped on that Thursday, and the next Monday
charges normally.

## 7. Bake sheet [Partly BUILT]

One screen per Thursday. Jay picks the Thursday (defaults to the next upcoming
one with orders).

### 7a. Summary (top of screen)
- **Total loaves to bake**, broken out as **ordered + extras** (baker's dozen,
  see 9b), e.g. "26 to bake: 24 ordered + 2 extra". Ordered includes
  expected renewals, noted as "includes 3 expected".
- Loaves for **local delivery**, **pickup**, and **shipping** (ordered loaves
  only; extras are not assigned to a stop)
- **Delivery stops:** one per unique local delivery address, plus one per
  pickup point that has orders, plus **one** for all shipping combined (all
  shipped loaves go out at a single UPS stop). Two orders to the same address
  are one stop.
- Count of **declined** orders, and count of **manual / standing** orders
- **Stops done vs. total**

### 7b. Each order entry shows
- Customer name and loaf count
- Source tag: **Subscription**, **One-time**, **Manual**, or **Barter**
- Status tags where they apply: **Expected (charges Wed)**, **Declined**
  (with a "resolved" action that clears the flag once Jay has handled it),
  **Partly refunded $X**, **Skipped** (greyed, not counted)
- 📍 **Map** link: opens the delivery address in Google Maps. The address
  itself is **not** displayed. (Local delivery only. Pickup entries show the
  pickup point name.)
- **Shipped entries show the full address**, laid out so it can be copied
  straight into Pirate Ship (with a one-tap copy button), until shipping is
  automated.
- ✉️ **Email** link: opens a new email to the customer (when an email exists)
- 📞 **Call / Text** links (only when a phone number exists)
- Note, if one was entered
- Edit actions (6c) and, for subscribers, skip controls (6d)

### 7c. Delivered
**Delivered belongs to the stop, not the order.** Each stop has one ✓
Delivered checkbox; ticking it marks every order at that stop delivered.
Saved on the server, so it survives closing the app.

### 7d. Grouping and order
Grouped by delivery method: Local Delivery, Pickup (sub-grouped by pickup
point with subtotals), Shipped. Local delivery entries are listed in route
order (section 8).

### 7e. Print
A print button producing a clean one-page bake-day sheet. [BUILT, to be
updated for the new fields]

**Acceptance:** for a Thursday with known orders, the summary numbers match a
hand count; every local delivery entry's Map link opens the right address;
no full street address is visible for local delivery entries; shipped
entries show a copyable full address; ticking a stop with two orders marks
both delivered.

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
  Google Maps app on Jay's Android phone straight into turn-by-turn driving
  directions to that stop.
- **One tap per stop:** a **"Delivered, next stop"** button ticks ✓ on the
  current stop and immediately opens Maps to the next one.
- **Coming back to the app:** Android may close the app in the background,
  so position is never kept only in the browser. Whenever the app opens or
  reloads, it lands on the same Thursday with all checkmarks intact and the
  next undelivered stop highlighted and scrolled into view, read from the
  server. The login lasts 30 days on the device, so a reload mid-route never
  asks for the password.
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

**Acceptance:** on Jay's Android phone, with the app installed: stops appear
in the order Google's optimization returned; Navigate opens Maps in
turn-by-turn directions to that stop; "Delivered, next stop" checks the stop
off and opens Maps to the next one; force-closing and reopening the app shows
the next stop highlighted with all checkmarks kept and no login prompt;
"View whole route" shows the full loop from home back to home.

## 9. App form [TODO]

The admin pages (orders, bake sheet, add order, standing orders,
subscribers, alerts, cancellations) become an **installable web app** (PWA):
added to Jay's Android home screen once, then opens full screen with its own
icon. Same code and hosting as the site; no app store. Must be usable
one-handed on a phone at the delivery stops (large tap targets, no
horizontal scrolling).

Not needed: offline mode, a native Android app.

**Acceptance:** on Jay's phone, "Add to Home screen" produces a JustBread icon
that opens the bake sheet full screen, still behind the admin password.

## 9b. Production schedule [TODO]

The weekly production scheduler (today a separate desktop app,
`scheduler/justbread_scheduler.py`) moves into this app and is **fed by the
orders**, instead of Jay typing loaf counts in by hand.

- **Input:** total loaves for each Thursday, taken from the bake sheet
  (paid, expected, declined-but-delivering, manual, and standing orders;
  not skipped, cancelled, or refunded), plus extras (below), plus the bake
  **start time**.
- **Extras, baker's dozen:** 1 extra loaf for every 12 ordered, i.e.
  `floor(ordered / 12)` (12 ordered -> 13 baked, 25 ordered -> 27 baked,
  11 ordered -> 11 baked). Shown separately from orders on the schedule and
  bake sheet ("24 ordered + 2 extra = 26 to bake"). Jay can override the
  extra count for a given week.
- **Start time:** the bake-day timeline is built **forward from when Jay
  starts on bake day** (Thursday), not backward from a finish time. Default
  **7:00 AM** (oven on), stored as a setting; Jay can change it for any single
  week without changing the default. Packaging and "done" times are
  calculated from it and shown on the schedule.
- **Fridge time stays fixed** at 2:00 PM the day before bake, whatever the
  start time. An earlier start just shortens cold time, which is the slowest
  ferment phase; no warning is shown.
- **Starter feed before the cutoff (buffer):** the Tuesday early-morning
  starter work is sized for the loaves known at that moment (orders, expected
  renewals, and baker's dozen extras) **plus a buffer** of 2 loaves (a
  setting, editable). At the Tuesday PM feed, after the noon cutoff, the
  schedule recalculates for the final count and tells Jay the exact amounts
  to use. Any buffer starter left unused is shown as surplus; if late orders
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

## 9c. Notifications, Alerts, and Cancellations [TODO]

Runs entirely on the server from Stripe webhooks. No Claude session and no
per-event approval is involved: once set up, Stripe notifies the site and the
site notifies Jay.

Jay is notified when:
| Event | Stripe signal | Notification says |
|---|---|---|
| Subscriber schedules a cancellation (in the portal) | `customer.subscription.updated` with `cancel_at_period_end` turning true | Name, plan, loaves, the date it ends, last delivery date, reason/comment if they gave one |
| Subscription actually ends | `customer.subscription.deleted` | Name, plan, loaves, how it ended (customer, failed payment, Jay), "removed from future sheets" |
| Subscriber undoes a scheduled cancellation | `customer.subscription.updated`, `cancel_at_period_end` back to false | Name, "staying" |
| Subscriber pauses / resumes (portal) | `customer.subscription.updated`, `pause_collection` set / cleared | Name, resume date if any |
| Payment declined | `invoice.payment_failed` | Name, amount, which Thursday it affects (same event as section 5) |
| Refund | `charge.refunded` | Name, amount, full or partial, which Thursday |

- Every notification is also kept in an **Alerts** list in the app, so nothing
  is lost if a notification is missed. Jay can mark alerts read.
- **Cancellations tab:** every scheduled cancellation and every ended
  subscription from the last 60 days, newest first: name, plan, loaves,
  scheduled-end or ended date, how it ended, and the customer's reason or
  comment. For a quick check without scrolling Alerts.
- Notifications must not repeat for the same event (Stripe may resend).
- The webhook endpoint must be subscribed to the events above (uses the
  `www.` URL; see CLAUDE.md).
- **Delivery: both.** Every alert goes out as (1) a **push notification** to
  Jay's Android phone from the installed app, and (2) an **email** to Jay via
  a transactional email service, which will be reused for the customer emails
  in "Later". If push fails or isn't set up on a device, email still goes
  out; neither depends on the other.
- Setup Jay does once: allow notifications when the app asks; create the
  email service account and add its key to Vercel (steps provided at build).

**Acceptance:** cancelling a test subscription in the portal produces one
notification within a minute, one entry in Alerts, and one row in
Cancellations; Stripe resending the same event produces no duplicate.

## 10. Open decisions

| # | Question | Options | Default if undecided |
|---|---|---|---|
| (none open) | | | |

Pending Jay's action, not decisions: go-live date (section 3), the
subscriber notice email and switchover dates (4a), the Stripe retry setting
(section 3).

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

## 12. Data model (for the build)

Anything the build needs to store is listed here. If it isn't here, add it
here first.

### `orders` (existing table) additions
- `source` TEXT: `stripe` | `manual` | `standing`
- `payment_status` TEXT: `paid` | `declined` | `refunded` | `unpaid` (manual) | `n/a` (barter)
- `refunded_cents` INTEGER, default 0 (partial refunds)
- `declined_resolved_at` TIMESTAMPTZ
- `cancelled_at` TIMESTAMPTZ (Jay cancelled this delivery, 6c)
- `history` JSONB (6c change log: field, old value, new value, when)
- `customer_phone` TEXT
- `note` TEXT
- `stop_key` TEXT (which stop this order belongs to on its Thursday; see `stops`)
- `standing_order_id` INTEGER, references `standing_orders`
- `stripe_invoice_id` TEXT, unique when present (one row per invoice; how a
  failed-then-paid invoice updates its own row)
- `stripe_event_id` and `stripe_customer_id` become nullable (manual and
  standing orders have neither)

### `subscriptions` (new): mirror of Stripe, read-only except via rule 9
`stripe_subscription_id` (PK), `stripe_customer_id`, name, email, phone,
cadence, loaves, delivery method, pickup point, address, status,
`next_renewal_at`, `pause_resumes_at`, `cancel_at_period_end`, `cancel_at`,
`ended_at`, `ended_reason` (`customer` | `failed_payment` | `jay`),
`cancellation_comment`, `updated_at`. Fed by `customer.subscription.*`
webhooks and refreshed by the daily cron. Feeds expected renewals (4c),
subscription controls (6d), and Cancellations (9c).

### `standing_orders` (new)
Name, contact fields, loaves, delivery method, address / pickup point,
frequency, start date, end date, paused flag, note, created/updated times.

### `standing_order_occurrences` (new)
`standing_order_id`, Thursday, state (`skipped` | `delivered` | `frozen`),
the loaves, address, and pickup point it had that day, note. Unique on
(standing order, Thursday). Written only when something happens to that
Thursday, or by the daily cron freezing a past one (6b).

### `stops` (new)
Thursday, `stop_key` (normalized address, pickup point, or `shipping`),
kind, label, `route_position`, `delivered_at`. Unique on (Thursday,
`stop_key`). Holds delivered state (7c) and route order.

### `routes` (new)
Thursday (PK), `computed_at`, `stop_set_hash` (so a change in stops
triggers recompute), `method` (`google` | `fallback`), notice text.

### `production_starts` (new)
Thursday, step (e.g. `starter_am`, `starter_pm`, `mix`), loaves it started
with, `started_at`. Drives the "changed after the starter feed" flags (9b).

### `settings` (new)
Key/value: home address, default bake start time, starter buffer, recipe
and timing constants, fridge-by time.

### `week_overrides` (new)
Thursday (PK), extras override, start time override.

### `alerts` (new)
`stripe_event_id` (unique, blocks duplicates), type, subscription id,
message, `created_at`, `read_at`.

### `push_subscriptions` (new)
Push endpoint (unique), keys, device label, `created_at`.

### `api_usage` (new)
Date, service (`google_routes`), count. Unique on (date, service). Backs
the app's own 150/day cap and the monthly usage line.

## 13. Change log

- 2026-10-30: Stripe settings from Jay's dashboard: retries finish within 5
  days then cancel (the "incomplete for N days" setting is for 3D Secure
  confirmations, not declines); customer email toggles; billing mode classic.
- 2026-10-30: Spec review. Reframed as a new build: database goes live on a
  chosen Monday and starts empty (section 3). Monthly keeps calendar billing;
  renewals are predicted and placed by a new rule (charge by Thursday noon ->
  that Thursday), with Expected entries (4b, 4c, rules 5 and 7). Weekly and
  every-other-week: new signups keep the full first charge at Checkout, then
  the webhook moves the first renewal to a Monday with `trial_end` (4a).
  Existing subscribers are emailed before their switch. Added Stripe write
  scope as an explicit exception to the safety contract (rule 9) and the
  test-clock requirement (rule 10). Added refunds, out-of-order replay rules,
  and handling when Stripe gives up on retries (section 5); Stripe retry
  setting (section 3). Added single-order edits (6c)
  and skip / skip until / resume subscription controls (6d). Standing orders
  are calculated for future Thursdays, not stored (6b), with required
  automated tests. Delivered moved from the order to the stop (7c). Android:
  Navigate opens turn-by-turn; state comes from the server after any reload;
  30-day login (8, 9). Fridge time stays fixed regardless of start time
  (9b). Added Cancellations tab and refund alerts (9c). Full data model
  (section 12).
- 2026-10-27: D8 decided: notifications go out by both push and email.
- 2026-10-27: Added 9c, notifications (cancel scheduled / ended / undone,
  pause/resume, declined) plus an in-app Alerts list. Bake sheet summary now
  shows ordered + extras. Open: D8 (push vs. email vs. both).
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
