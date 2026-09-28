# CLAUDE.md — JustBread Project Notes
> Read this at the start of every session. Update it when anything significant changes.

---

## Project Overview
JustBread (justbread.shop) is a premium sourdough bread business in the Geneva/Batavia/St. Charles, IL area.
- Flour, water, salt only. 9-day cold ferment. No commercial yeast.
- Owner: Jay (justinrush9). Solo operation.
- Charitable component: product donated to CFFEM (Center for Food Equity in Medicine) grocery delivery program.

---

## Architecture

### Two Vercel Projects
1. **justbread-site** (`justbread.shop`)
   - GitHub repo: `justinrush9/justbread-site`
   - Local path: `C:\Users\justi\Documents\justbread-site`
   - Static site — HTML/CSS/JS only, no framework
   - Auto-deploys from `main` branch on push
   - Contains the frontend + `/api` folder (Vercel serverless functions)

2. **justbread-api** (`justbread-api.vercel.app`)
   - Separate Vercel project for the Stripe checkout backend
   - NOTE: As of June 2026, the `/api` folder was moved INTO justbread-site and justbread-api may be deprecated — verify which project is actually serving the API before making changes.
   - Environment variables: `STRIPE_SECRET_KEY`, `ALLOWED_ORIGIN`, `SUCCESS_URL`, `CANCEL_URL`

### Site Structure
```
justbread-site/
  index.html          # Homepage with zip checker
  order/index.html    # Order page (subscribe or one-time)
  manage/index.html   # Subscription management portal
  order-confirmed/    # Post-checkout confirmation page
  faq/index.html      # FAQ page
  images/             # hero.jpg and other assets (NOT base64 embedded)
  admin/
    index.html        # /admin — password-gated order dashboard + "Sync from Stripe" button
    bake-sheet/
      index.html       # /admin/bake-sheet — production view: what to bake, grouped by fulfillment date + delivery method
  api/
    checkout.js       # POST /api/checkout — builds Stripe Checkout Session
    portal.js         # POST /api/portal — creates Stripe Billing Portal session
    webhook.js        # POST /api/webhook — Stripe webhook, dispatches to lib/orderProcessing.js
    orders.js         # GET /api/orders — backs /admin, password- or cron-secret-gated
    reconcile.js       # GET /api/reconcile — re-walks Stripe events, fills in anything the webhook missed
    bake-sheet.js      # GET /api/bake-sheet — backs /admin/bake-sheet, grouped by fulfillment_date
  lib/
    prices.js         # shared price ID catalog (checkout.js + orderProcessing.js both use this)
    deliveryCodes.js  # RGD/ECB/etc. pickup-point codes (checkout.js + orderProcessing.js)
    fulfillment.js    # Tuesday-noon cutoff rule -> which bake week an order lands on
    orderProcessing.js # shared order-ingestion logic — webhook.js and reconcile.js both call into this
    adminAuth.js       # shared auth for orders.js/reconcile.js (admin password or CRON_SECRET)
  db/
    schema.sql        # orders + bakes tables — idempotent, safe to re-run after a migration is added
    client.js          # shared pg Pool, reads DATABASE_URL
  package.json
  vercel.json          # includes the daily reconcile cron
```

---

## Stripe Setup

### Pricing Model (June 2026 restructure, tag: build=justbread_restructure_2026)
- **Local delivery subscription**: $10/loaf + $5 flat delivery = $15/loaf delivered
- **Local delivery one-time**: $10/loaf + $7 flat delivery = $17/loaf delivered
- **IL shipping one-time**: $10/loaf + shipping (1 loaf=$7, 2=$8, 3=$9, 4+=$9/box)
- Local ZIPs: 60134, 60174, 60175, 60510

### Price IDs (live)
```
loaf.onetime:  price_1TgTWrJVnPyvSLMUoZrOGnXA
loaf.weekly:   price_1TgTWrJVnPyvSLMUG2yl50f1
loaf.biweekly: price_1TgTWrJVnPyvSLMUyxTz6UQr
loaf.monthly:  price_1TgTWrJVnPyvSLMUaUFP0ho9
localSub.weekly:   price_1TgVeQJVnPyvSLMUZ2n1yLax
localSub.biweekly: price_1TgVeRJVnPyvSLMUK0ukeVkj
localSub.monthly:  price_1TgVeRJVnPyvSLMUFuohG0SJ
localOnetime: price_1TgVeRJVnPyvSLMUK2e4GsPX
```
**SAFETY CONTRACT: June 2026 restructure is ADDITIVE ONLY. Never modify or delete existing Stripe products, prices, customers, or subscriptions. Existing subscriptions remain on legacy price IDs untouched.**

### Stripe Keys (as of June 11, 2026)
- One live secret key active, named `Vercel Production` in Stripe dashboard
- Set as `STRIPE_SECRET_KEY` in Vercel environment variables for justbread-api
- Publishable key: keep, never delete (used by frontend)

### Customer Portal
- Configured in Stripe Dashboard → Settings → Billing → Customer portal
- Enabled: cancel subscriptions, pause subscriptions, update payment method
- Return URL: `https://justbread.shop/manage/`
- Frontend: `justbread.shop/manage` — subscriber enters email, gets redirected to Stripe portal
- Backend: `POST /api/portal` in portal.js

---

## Delivery & Logistics
- Local delivery: Fridays, Geneva/Batavia/St. Charles area
- IL shipping: ships Wednesday via UPS Ground, arrives Thursday
- Subscription cadences: weekly, biweekly (every 2 weeks), monthly

---

## Key Decisions & History

### Migration (June 2026)
- Migrated FROM: GoDaddy WordPress/Elementor (cancelled)
- Migrated TO: Static site on Vercel + Stripe checkout API
- GoDaddy WordPress and Elementor subscriptions: CANCELLED
- Old Downloads/justbread-site folder: can be deleted, use Documents/justbread-site

### Hero Image
- Was embedded as base64 data URI in index.html (caused 1.4MB file, bad practice)
- Fixed June 2026: extracted to `images/hero.jpg`, CSS references `url('/images/hero.jpg')`

### Hamburger Menu
- Added June 2026 to index.html and all other pages
- Mobile breakpoint: 600px (index.html), 680px (manage/index.html)
- Tap outside to close behavior included

### Checkout Button Back-Navigation Fix
- Added `pageshow` event listener to reset button state when user hits Back from Stripe
- Applied to `order/index.html`

### Zip Routing
- Homepage has zip checker; passes zip via URL param (`?zip=XXXXX`) and sessionStorage
- Order page reads zip from URL or sessionStorage
- Server-side re-validation in checkout.js prevents zone spoofing
- No zip = error message shown, checkout blocked

---

## Git Workflow
- Working directory: `C:\Users\justi\Documents\justbread-site`
- Remote: `https://github.com/justinrush9/justbread-site.git`
- Branch: `main`
- Push commands (PowerShell — use separate lines, not &&):
  ```
  git add -A
  git commit -m "your message"
  git push
  ```
- Vercel auto-deploys on push to main (may take 1-2 minutes to appear)

---

## Things to NOT Do
- Never modify or delete existing Stripe prices, products, customers, or subscriptions
- Never embed images as base64 in HTML
- Never use `&&` in PowerShell (use separate commands)
- Don't touch the `paX6` original secret key unless explicitly confirmed safe
- justbread-site in Downloads folder is stale — ignore it

---

## Known Issues / Watch Out For
- **Base64 corruption**: faq/index.html and manage/index.html have been corrupted to raw base64 text at least twice. Root cause unknown — possibly a tool writing base64 instead of decoded content. fix-base64.py in repo root decodes them. Run it if either page shows raw text instead of rendering. After running, always check the nav links are correct and push.

## Order Management (started Sep 2026)
- Problem: manually tracking weekly orders in a spreadsheet, missed orders happen.
- New Postgres-backed `orders` table, populated automatically by `api/webhook.js`
  on every `checkout.session.completed` (one-time) and `invoice.paid` (subscription,
  including first payment) event.
- Fulfillment type (`local` vs `shipped`) is derived from which price IDs were
  actually purchased (see `lib/prices.js`), not from metadata alone — more robust
  since metadata can go missing on older subscriptions.
- `checkout.js` now also sets `subscription_data.metadata` so zip/zone/loaves
  survive onto the Subscription object, not just the one-time Checkout Session.
- LIVE as of Sep 15, 2026. Postgres provisioned — Neon via Vercel Marketplace,
  connected to the justbread-site project. `DATABASE_URL` (and related Neon
  vars) auto-set for Production/Preview/Development. `db/schema.sql` applied —
  `orders` and `bakes` tables exist. To browse the data: `vercel integration
  open neon neon-violet-dog` opens an SSO'd Neon SQL console.
- Stripe webhook endpoint `we_1UG1lvJVnPyvSLMURSeFbrKg`, listening for
  `checkout.session.completed` and `invoice.paid`, URL
  `https://www.justbread.shop/api/webhook` (see gotcha below re: www).
  `STRIPE_WEBHOOK_SECRET` set in Vercel Production.
  - An earlier endpoint (`we_1UFz0fJVnPyvSLMUwnPggTzB`) existed from a prior
    session but its signing secret was never captured, so events were
    failing signature verification — it's now disabled (this Stripe
    connection only exposes create/update via API, not delete).
- **Gotcha found Sep 15: `justbread.shop` (apex) 308-redirects to
  `www.justbread.shop`.** Stripe does not follow redirects when delivering
  webhooks, so the webhook endpoint URL MUST be the `www.` form or every
  delivery silently fails (this cost us one real subscriber's order before
  being caught). If you add any other server-to-server integration
  (email service, another webhook consumer, etc.), point it at `www.` too.
  Whether to flip the redirect direction so apex is canonical (matching
  every other URL in this codebase — success_url, cancel_url, manage
  return URL, this doc) is still an open question; that's a Vercel
  dashboard-only setting (Project → Domains), not CLI-scriptable — ask
  before changing it since it affects every existing link out there.
- Loaf counting in `lib/prices.js` covers the current price catalog plus 5
  grandfathered legacy subscription prices (see `LEGACY_LOAF_PRICES` in that
  file) — confirmed against Stripe product descriptions, with the one
  genuinely ambiguous case ($35/mo "Every-Other-Week Subscription", 7
  subscribers) confirmed directly with Jay: 2 loaves/invoice, local delivery.
  Note that price represents an ongoing alternating-week schedule that
  varies per subscriber — a single invoice can't tell you which week is
  whose "on" week, so per-week delivery scheduling is still unsolved (see
  bake-to-order linking below).
### Delivery mechanic, address, and fulfillment-date fields (Sep 28 2026)
- `orders` now has `delivery_method` ('pickup' | 'local_delivery' | 'shipped'),
  `pickup_location` (drop-point label), `shipping_address` (JSONB), and
  `fulfillment_date` (DATE — which bake week the order is assigned to).
  Migration is in `db/schema.sql`, idempotent, backfills existing rows from
  what was already sitting in `raw_metadata`. **Still needs to actually be
  run against the live Neon DB** — psql the DATABASE_URL from `vercel env
  pull`, or paste it into the Neon SQL console (`vercel integration open
  neon neon-violet-dog`).
- `delivery_method` is derived in `lib/orderProcessing.js` classifyDelivery():
  a `delivery_code` in metadata always means `pickup` (label comes from
  `lib/deliveryCodes.js`); otherwise `fulfillment_type === 'local'` means
  `local_delivery`; otherwise `shipped`.
- `shipping_address` is captured for `local_delivery` and `shipped` (never
  `pickup` — that goes to a fixed drop point, not the customer's own
  address). For one-time orders it reads `session.shipping_details` (falling
  back to `customer_details`) directly off the Checkout Session. For
  subscriptions, `invoice.paid` doesn't carry the address itself, so it's
  read off the Customer object (`customer.shipping`), which Stripe
  populates from what was collected at the original Checkout.
  **UNVERIFIED — confirm against a real test order**: exact field naming on
  Checkout Session/Customer objects can shift between Stripe API versions;
  this was written from documented behavior, not tested against a live
  session. If `shipping_address` is coming back null on an order that
  clearly provided one, check the field name first.
- `fulfillment_date` cutoff rule (`lib/fulfillment.js`): orders at or before
  Tuesday 12:00 PM America/Chicago target that week; later orders roll to
  next week. Within the target week: shipped -> Wednesday, local delivery
  -> Friday, pickup -> Friday. **The pickup day is an ASSUMPTION** (that
  drop-point deliveries happen on the same run as local delivery) — confirm
  with Jay and adjust `OFFSET_FROM_TUESDAY.pickup` in `lib/fulfillment.js`
  if any drop point actually runs on a different day.
  Jay is handling capacity edge cases (e.g. a huge order right at the
  cutoff) manually rather than this being automated.
  fulfillment_date is NOT backfilled onto pre-migration orders — computing
  it retroactively from `created_at` would misrepresent orders that were
  already fulfilled under no formal rule at all.

### Reconciliation (Sep 28 2026)
- `GET /api/reconcile?days=N` re-walks Stripe's Events API for the lookback
  window (default 3 days, max 30) and replays any `checkout.session.completed`
  / `invoice.paid` event not already in `orders`. Idempotent on
  `stripe_event_id`, so safe to run anytime, including manually after fixing
  something that was broken for a while (bump `days`).
- Runs automatically once a day via the cron in `vercel.json`
  (`0 13 * * *`, roughly 7-8am Central depending on DST — a daily catch-up
  sweep, so the DST drift doesn't matter). **Requires `CRON_SECRET` to be
  set in Vercel env vars** — Vercel sends it as `Authorization: Bearer
  <CRON_SECRET>` automatically on cron-triggered requests once the var
  exists, no other config needed. Not yet set — do this before relying on
  the cron.
- The `/admin` page has a "Sync from Stripe" button that hits the same
  endpoint with the admin password instead.
- `api/webhook.js` and `api/reconcile.js` share all their event-processing
  logic via `lib/orderProcessing.js`, so the two paths can't drift apart —
  there's exactly one implementation of "what happens when this Stripe
  event is seen," whether it arrives live or gets found later.

### Bake sheet (Sep 28 2026)
- `/admin` is a payment log ordered by when Stripe charged someone; it never
  answered "what do I actually bake, and where does it all go." That's what
  this is.
- `GET /api/bake-sheet` (no `date`) returns upcoming/recent `fulfillment_date`s
  with order/loaf counts, for quick-pick chips. `GET
  /api/bake-sheet?date=YYYY-MM-DD` returns full production detail for that
  date: every order with `delivery_method`, `pickup_location`,
  `shipping_address`, sorted by delivery method then zip/pickup location then
  customer name, plus totals per delivery method. Same `isAdminRequest` auth
  as `/api/orders`.
- `/admin/bake-sheet/` is the page: date picker (chips + manual date input,
  auto-selects the earliest upcoming date with orders), grouped/sub-grouped
  by delivery method (Local Delivery and Shipped sorted by zip; Pickup
  sub-grouped by drop point with subtotals), a print button, and print CSS
  for a clean bake-day printout. Both admin pages now cross-link via a nav
  bar (Orders / Bake Sheet).
- Orders with `fulfillment_date IS NULL` (pre-migration, before the Sep 28
  backfill) won't show up here — only in `/admin`.

### What's built vs. not (corrects a stale note below from the initial
Sep 15 build — `/admin` and `/api/orders` exist and have for a while)
- Built: webhook ingestion, `/admin` dashboard + password auth, reconciliation
  sweep + daily cron, delivery-method/address/fulfillment-date capture,
  bake sheet production view (`/admin/bake-sheet/`).
- NOT built yet: bake-to-order linking (`orders.bake_id` / the `bakes` table
  is still unused), the alternating-week legacy-subscriber scheduling
  problem, customer emails, customer-facing status page, subscription
  payment-day anchoring, and migrating legacy subscribers off grandfathered
  prices. All still read from the same `orders` table — see chat history for
  the full architecture discussion.

## Outstanding / Future Work
- **REMIND JAY: Fix OneDrive Documents redirection.** OneDrive is hijacking the Documents folder. The repo lives at the literal `C:\Users\justi\Documents\justbread-site`, but File Explorer's "Documents" shortcut may point to `C:\Users\justi\OneDrive\Documents`, so the folder appears missing in the file browser. Jay wants to stop OneDrive from taking over Documents. (Raised June 15, 2026.)
- **Scheduler FORKED into two projects (June 15, 2026):**
  - **Project 1 — Tkinter desktop app (DONE, the fallback).** Lives in `scheduler/`. (1) Print fixed: `pdf_builder.py` was loaded dynamically so PyInstaller never bundled it or reportlab — now inlined into `justbread_scheduler.py` as module-level `build_pdf()` (PDF fonts renamed F_PDF/FB_PDF to avoid clashing with the Tkinter FB font constant). (2) Timing fixed: dough used to back-schedule off the next day's bake done-time (→ 4:30 AM mix). Now back-scheduled from a fixed "in fridge by" target `FRIDGE_BY_H/M` (default 2:00 PM → 6:30 AM mix), editable in two constants at top. (3) `JustBread.spec` updated: dropped pdf_builder data bundle, added reportlab hidden imports. Original saved as `justbread_scheduler_v1_backup.py`. Build: `pip install reportlab pyinstaller` then `python -m PyInstaller JustBread.spec`.
  - **Project 2 — web app rebuild (NEXT).** FastAPI + pywebview shell + SQLite bake log + Claude API "coach" + HTML/Chart.js dashboard, packaged to one .exe. Reuse all recipe/timing/supply math. Goal: smart pattern suggestions from handwritten bake observations + impressive UI.
