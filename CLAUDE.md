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
  api/
    checkout.js       # POST /api/checkout — builds Stripe Checkout Session
    portal.js         # POST /api/portal — creates Stripe Billing Portal session
  package.json
  vercel.json
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

## Outstanding / Future Work
- (Add items here as they come up)
