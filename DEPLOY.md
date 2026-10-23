# Deploying

This covers two setups:

- **A private demo preview** on sample data, so the owner can click around: 8 shops, barbers by first name, about 3,000 clients (families on a shared phone included), eight weeks of appointments and sales, two weeks of upcoming bookings, inventory, vendors, and purchase orders. Cards run on the payment simulator, nothing is texted or emailed, and there are one-click demo logins.
- **Production**, for the real cutover. It's the same project with different environment variables.

Both run on **Vercel** (the app) and **Neon** (Postgres). Supabase works in place of Neon.

## What you need to provide

| What | Where to get it | Needed for |
| --- | --- | --- |
| A Vercel account and a project linked to this GitHub repo | [vercel.com/new](https://vercel.com/new), sign in with GitHub, import `stephens818-maker/rayz-shop-platform` | Both |
| A Neon Postgres database | Easiest is Vercel → your project → **Storage** → **Create** → **Neon**, which adds the connection strings for you. Or sign up at [neon.tech](https://neon.tech) and copy them. Pick region **AWS US East 2 (Ohio)** to sit next to the app (`cle1` in `vercel.json`). | Both |
| Two random secrets | Run `openssl rand -base64 48` twice | Both |
| Stripe test keys (optional) | [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys) | Only to try real Stripe test mode; without them the built-in simulator runs |

**Vercel plan.** The reminder queue runs every 5 minutes on Vercel Cron, which needs **Vercel Pro**. Pro is also what Vercel's terms require for a business. On the free Hobby plan, a deploy with a cron more frequent than daily is rejected. To try the demo on Hobby anyway, change the schedule in `vercel.json` to `"0 12 * * *"` (once a day). The demo doesn't send anything, so nothing is lost.

## Demo preview, step by step

1. **Create the project.** On [vercel.com/new](https://vercel.com/new), import the repo. Vercel detects Next.js and pnpm. Leave the build settings as they are: `package.json` has a `vercel-build` script, which Vercel runs instead of `build`. If you're deploying before this branch is merged, set **Settings → Git → Production Branch** to `cursor/rayz-barbershop-v1-8f0b`.
2. **Add the database.** In the project, open **Storage → Create Database → Neon**, pick US East 2 (Ohio), and connect it to all environments. That sets `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct). If you made the database on neon.tech instead, add those two variables yourself: the pooled string (host contains `-pooler`) as `DATABASE_URL`, and the direct one as `DATABASE_URL_UNPOOLED`.
3. **Add the environment variables** under **Settings → Environment Variables**:

   | Variable | Value |
   | --- | --- |
   | `DEMO_MODE` | `true` |
   | `AUTH_SECRET` | the first random secret |
   | `CRON_SECRET` | the second random secret |
   | `SEED_PASSWORD` | optional: your own password for every demo login. Without it, the password is `rayz2026!` and it's shown on the sign-in page. |
   | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | optional: Stripe **test** keys. In demo mode a live key is ignored and the simulator runs. |

   Leave `NOTIFICATIONS_*` and `APP_BASE_URL` unset. Links default to the project's production URL.
4. **Deploy.** Click **Deploy**, or push to the production branch. The build applies the migrations and, because the database is empty, loads the demo data. That adds about a minute to the first build. Later builds only apply new migrations and keep the data. If the demo data was loaded before Stripe Connect, the next build gives each shop with card history a simulated Stripe account (`scripts/demo-connect.ts`), so checkout keeps working.
5. **Keep it private.** Anyone with the URL can use the demo logins. Under **Settings → Deployment Protection**, turn on **Vercel Authentication** for all deployments, so only people on your Vercel team can open it, or **Password Protection** (a Pro add-on) to share one password.
6. **Open it.** Go to the production URL and use the **Staff** link at the bottom, or open `/login` directly. Pick a demo login.

### Demo logins

| Login | Email | What it shows |
| --- | --- | --- |
| Brand owner | `owner@rayz.test` | Every shop, every report, all brand settings (permissions, client data protection, loyalty) |
| Shop login | `coralville@rayz.test` (or any shop: `moline@rayz.test`, `kimberly@rayz.test`, …) | One shop's front desk: calendar, walk-ins, checkout, drawer, stock |
| Barber | `makenna@rayz.test` | Her own column, clients (contact details masked), and sales |
| Shop manager | `michelle@rayz.test` | Coralville's manager tools and reports |

The password is `rayz2026!` unless you set `SEED_PASSWORD`. The [README](README.md#logins-seeded-password-rayz2026) lists more logins: admin, regional, front desk, a multi-shop barber.

Things to try:

- **Book online:** open `/`, pick a shop, and book. To sign in as a customer at `/account`, use a seeded phone such as `319-555-0100` (Jordan) or `319-555-0201` (the Hayes family: three people on one phone). The one-time code is shown on screen in demo mode.
- **Check out:** open the calendar as `coralville@rayz.test`, click an appointment, choose **Check out**, add a tip, and pay with a test card such as "Visa (credit)".
- **Customer screen:** on the same ticket, tap **Hand to customer** instead. Pick a tip, a receipt and a test card on the client's side, then hand it back: the device returns to staff by itself after the thank-you, or tap **Staff** and use a time clock PIN (every demo barber's is `2468`).
- **Receipts:** after paying, choose **Text** or **Email** on the ticket. The text is under **Notifications** (suppressed); open its `/receipt/…` link on a phone. Refund the ticket and the same link shows the refund, and an updated receipt is queued. Clients ask for copies at `/receipt`.
- **Gift card and promo:** `DEMO-GIFT-2500` holds $25, and `WELCOME5` takes $5 off.
- **Messages:** every confirmation, reminder, and purchase order email that would have gone out is listed under **Notifications** as "suppressed".

### Refreshing the demo data

The sample bookings are relative to the day the data was loaded, so after a couple of weeks the calendar ahead runs empty. To reload:

- set `DEMO_RESEED=true` in Vercel, redeploy, then delete the variable (otherwise every deploy wipes the data again); or
- from a laptop with the repo: `DATABASE_URL="<the pooled Neon string>" pnpm db:reset`.

Either way, the reload wipes everything in the database, including anything typed into the demo.

## What demo mode changes

`DEMO_MODE=true` (see `src/lib/deployment.ts`):

- **Cards:** the payment simulator runs, or Stripe if the key is a test key (`sk_test_…`). A live key is ignored.
- **Texts, emails, and calls:** none are sent, whatever the `NOTIFICATIONS_*` variables say. They're queued and shown in the outbox as "suppressed".
- **Customer sign-in codes** are shown on screen, because nothing is texted.
- **The sign-in page** lists the demo logins, with one-click sign-in.
- **A banner** on every page says it's a demo.
- **The build** loads the sample data into an empty database.

Never set `DEMO_MODE` on a deployment with real clients.

## Production

Use a **separate** Vercel project and Neon database (or at least a separate Neon branch) from the demo.

1. Create the project and database as above, in US East 2 (Ohio).
2. Set the environment variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | set by the Neon integration (or `MIGRATE_DATABASE_URL` for the direct string) |
   | `AUTH_SECRET`, `CRON_SECRET` | new random secrets, not the demo's |
   | `APP_BASE_URL` | the public URL, e.g. `https://book.rayzbarbershop.com` |
   | `AUTH_DEV_CODES` | `false` |
   | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | live keys at cutover |
   | `STRIPE_CONNECT_WEBHOOK_SECRET` | the signing secret of the Connect webhook (step 4) |
   | `CONNECT_FEE_KEYED`, `CONNECT_FEE_TERMINAL` | optional: the processing fee passed on to each shop, e.g. `2.9%+30` and `2.7%+5` (the defaults) |
   | `STRIPE_STATEMENT_PREFIX` | optional: the start of card statements for shops on the brand account (default `RAYZ`, shown as `RAYZ* CLINTON`). It should match the brand account's shortened descriptor in Stripe. |
   | `TIP_INSTANT_FEE` | optional: Stripe's instant payout fee taken from an employee's instant tip payout, as a percentage and a minimum in cents, e.g. `1.5%min50` (the default) |
   | `NOTIFICATIONS_*` | leave `disabled` until the shop goes live (see the README's cutover plan) |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | the Twilio account, for texts, call-in calls and the shop line. Set `NOTIFICATIONS_SMS_PROVIDER` and `NOTIFICATIONS_VOICE_PROVIDER` to `twilio` when the shop goes live. |
   | `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM` | optional fallbacks for shops without their own Twilio number |

   Don't set `DEMO_MODE`. Without it the build only ever applies migrations. It never seeds.
3. Deploy. The build applies migrations. To run them yourself instead, set `SKIP_DB_MIGRATE=true` and run `DATABASE_URL_UNPOOLED=… pnpm db:migrate`.
4. Set up Stripe:
   - Turn on **Connect** for the platform account (Express accounts; the platform pays the fees and covers losses). Add the brand's bank account to the platform account. Shops set to **Brand account** are paid out there.
   - Turn on **Terminal**. The app creates one Terminal Location per shop from its address the first time a reader is registered there. Readers are registered with the code they show, under **Shop settings → Card readers**.
   - Point a Stripe webhook at `https://<your domain>/api/stripe/webhook` for `charge.refunded`, `charge.dispute.created`, and `payout.created`, `payout.updated`, `payout.paid`, `payout.failed` and `payout.canceled` (the brand account's own payouts), and `transfer.reversed` (a tip payout pulled back). Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
   - Add a second webhook, set to **listen to events on connected accounts**, at `https://<your domain>/api/stripe/connect` for `account.updated`, `capability.updated`, `account.external_account.created`, `account.external_account.updated`, `account.external_account.deleted`, `account.application.deauthorized`, and the same five `payout.*` events. Copy its signing secret into `STRIPE_CONNECT_WEBHOOK_SECRET`. The same webhook carries employees' tip payout accounts: their onboarding status and the `payout.paid`, `payout.failed` and `payout.canceled` of each tip payout.
   - Then open **Location setup** for each shop. Under **Payments and banking**, the Brand Owner (or someone they've given the banking permission) picks the shop's own Stripe account, the brand account, or cash only. For the shop's own account, they finish Stripe's onboarding, where Stripe collects the legal entity, EIN, owner identity and bank. The app keeps only the Stripe account ID and the status Stripe reports. A shop on its own account takes cards only once Stripe enables charges.
5. Set up Twilio (when texts and calls go live):
   - Buy a number per shop and enter it under **Shop settings → Twilio number**. Calls to it ring the shop's phone; missed and after-hours calls get a text with a booking link.
   - For each number, point the messaging webhook at `https://<your domain>/api/twilio/sms` and the voice webhook at `https://<your domain>/api/twilio/voice` (HTTP POST). The app sets the status and call-flow webhooks itself. All are verified with `X-Twilio-Signature`, so `APP_BASE_URL` must match the domain Twilio calls exactly.
   - Register the numbers for A2P 10DLC (brand and campaign) before texting clients; carriers filter unregistered texts.
6. Set up the time clock, per shop, under **Payroll → Time clock setup**:
   - Enter each shop's latitude and longitude (the seeded ones are approximate, city-level) and its public IP address. While on the shop Wi-Fi, the page shows the address you're connecting from.
   - The network check reads the client's address the same way sign-in restrictions do (step 9): on Vercel from `x-real-ip`. Self-hosted, it needs `TRUSTED_PROXY_HOPS`. Without it the address is unknown and network punches are refused, so use the device or GPS check instead.
   - Register each front-desk iPad from **Front-desk clock** on the iPad itself. The seeded devices can't be used.
   - Have each person set their PIN on **Time clock**. The seed's demo PIN only exists in seeded data.
   - The notifications cron (every 5 minutes) also flags forgotten clock-outs and emails managers about barbers not clocked in for their first client. Once a night around 3 AM shop time it checks full-time and part-time crossings. Nothing else needs scheduling. On the Hobby plan's daily cron, forgotten clock-outs are flagged once a day, the not-clocked-in email mostly won't arrive in time (Today still shows it), and the FT check only runs if that daily run lands between 3:00 and 3:15 AM. Emails about clients booked over a break or clock-out go right after the punch either way.
   - Review **The clock blocks out the calendar** for each shop (migration `core_0032_clock_blocks` adds the columns and the Clocked out and Not in yet reasons). A break writes a block-out for its planned length, or 30 minutes when none is picked. An early clock-out blocks the rest of the shift. "Not in yet" blocks are off until a shop turns them on. The blocks apply to online and desk booking alike. Booking always reads an open break as reaching 15 minutes past now, so the Hobby plan's daily cron doesn't matter here; the stored row is moved on by the cron and whenever the calendar or Today is opened. Opening time for an early clock-in is off until a shop turns it on and each barber allows it on their **Time clock** page.
7. Set up tip payouts (migrations `core_0033_tip_payouts` and `core_0034_staff_banking`):
   - The migration records every tip already rung up as paid before tip payouts, so nothing in the history is paid again. Tips from the first day after it are unpaid. Run it, or at least turn tip payouts on, the morning after the last payroll that paid tips the old way.
   - Every shop starts on **Manual** with cash and no card fee netting. Set each shop's schedule, card settlement delay and default method under **Tip payout settings**, and the brand's allowed methods. Don't turn on card fee netting until the accountant confirms it.
   - Stripe payouts to employees use Express accounts on the platform, with Stripe-hosted onboarding from **My banking** (migration `core_0034_staff_banking` adds the payout destination's type, name and last 4). The Connect webhook's `account.external_account.*` events (step 4) keep each employee's destination current and trigger their security notices, so make sure they're selected. Email and SMS must be configured for the notices to arrive. For shops on their own Stripe account, the money is first taken from the shop's account with an account debit, which Stripe allows only for some platforms and accounts; confirm with Stripe that the platform can debit its connected accounts before going live. Shops on the brand account pay from the platform balance, which needs enough available funds.
   - Instant payouts need Stripe's approval for the platform and an eligible debit card on the employee's account. Turn them off under **Tip payout settings** if Stripe hasn't enabled them.
   - The notifications cron builds the daily and weekly drafts once they're due. Managers still approve each one, and nothing goes out on its own. On the Hobby plan's daily cron that still works, just at that time of day.
   - Confirm the iSolved earning code for tips paid through payroll under **Payroll → Setup** before anyone is paid that way.
8. Keep financial and identity data with Stripe (migration `core_0035_scrub_sensitive`; see [What we store and what Stripe stores](README.md#what-we-store)):
   - **Tax forms:** in the Stripe Dashboard, open **Connect → Tax reporting** (Tax forms), pick the 1099-K form type and switch on e-delivery, so Stripe files the forms and connected accounts get them in their Express dashboards. Stripe collects each account's TIN during onboarding. Leave employees' tip payout accounts out of 1099 reporting: their tips are W-2 wages, reported through payroll. Have the accountant confirm both before the first January.
   - **PCI:** check the SAQ type under **Dashboard → Settings → Compliance** once live, card readers included. Keyed cards only pass through Stripe's Payment Element, and production checkout pages send a Stripe-only Content-Security-Policy (`CHECKOUT_CSP` in `next.config.ts`). If checkout ever loads another script, a font or an image host, add it there, or it will be blocked.
   - **Logs:** the server scrubs every `console` call (`src/instrumentation.ts`), so Vercel's logs and log drains get scrubbed text. Don't log request bodies elsewhere.
   - **Error tracking or analytics:** none is installed. If one is added, pass every event through `scrub()` from `src/lib/sensitive.ts` in its `beforeSend`, and turn off its request-body, form-input and session-replay capture on checkout.
   - **Backups:** the migration scrubs existing rows once and records a `privacy.scrub_existing` audit entry if any changed. Neon's point-in-time history from before that keeps the old rows until its restore window passes.
9. Limit where staff sign in (migration `core_0036_network_access`; see [Sign-in restrictions](README.md#sign-in-restrictions)):
   - The migration leaves every shop's restriction off and gives Brand Admin **Can access remotely**. Nothing changes until someone turns a location on.
   - For each shop, sign in on the shop Wi-Fi, open **Setup → Sign-in security**, press **Use my current IP**, and check that the address matches the shop's internet service. Ask the provider whether the address is static. If it isn't, choose **From the shop's network or on an approved device** and approve the shop's devices from **This device** on each one.
   - Give **Can access remotely** to the managers who work from home, under **Permissions**, before turning a shop on.
   - The client's address comes from `x-real-ip`, which Vercel's edge sets and clients can't override. Nothing needs setting on Vercel. Self-hosted, set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app (1 for a single nginx or load balancer that appends to `x-forwarded-for`). Without it the address is unknown and restricted shops refuse every request.
   - The middleware runs on the Node runtime (`runtime: "nodejs"` in `src/middleware.ts`) because it reads the database. Next.js 15.5 supports this on Vercel with no setting. It only looks up rules for signed-in `/admin` requests, and stops after one indexed query while no shop has a rule on.
   - Blocked-sign-in alerts go out by email through the notifications cron, so email must be configured.
10. Set up the customer screen at checkout (migration `core_0037_handoff`; see [Customer screen at checkout](README.md#customer-screen-at-checkout)):
   - The migration gives every shop the brand's tip buttons (20/25/30%, custom, no tip), except shops whose own tip presets weren't the default, which keep theirs. It also gives Brand Admin `handoff.unlock` and `handoff.settings`, and Regional and Shop Managers `handoff.unlock`. Nothing changes at the counter until someone taps **Hand to customer**.
   - Under **Setup → Shop settings**, set the brand's tip buttons, then each shop's **Customer screen at checkout**: its own buttons or the brand's, signature, any staff PIN or a manager's only, and the thank-you time.
   - **Any staff PIN** means anyone with access to the shop and a time clock PIN can take the device back, so make sure each person has set their PIN on **Time clock**. Without one, they can't unlock it.
   - **Tips on the reader:** with live Stripe keys and a registered reader, saving the setting pushes the shop's first three buttons to a Terminal configuration on its Stripe Terminal Location. If Stripe refuses, the settings page says so; save again once it's fixed. Reading the tip back from a real reader isn't wired yet (see the README's Next steps), so keep shops on **On the customer screen** until it is.
   - The middleware now runs on every page, not just `/admin` (matcher `/((?!_next/|api/|.*\..*).*)`), so a handed-over browser can't leave the customer screen. Without the `rayz_handoff` cookie, non-admin pages pass straight through with no database query. With it, there's one indexed lookup per request.
   - On shop iPads, turn on **Guided Access** (Settings → Accessibility) so the client can't leave the browser either. The app locks itself, not the device.
11. Set up digital receipts (migration `core_0038_digital_receipts`; see [Digital receipts](README.md#digital-receipts)):
   - The migration adds the receipt history and the receipt email opt-out list. Existing receipt settings get no review link and no Print button, so the ticket's Print button disappears; turn **Show a Print button** back on under **Shop settings → Receipts** for any shop that still needs paper.
   - Enter each shop's review link (`https://` only) under **Shop settings → Receipts**.
   - Receipt links are built from `APP_BASE_URL`, so set it to the public domain before texts or emails go live, or every link points at the wrong host. Links never expire, so don't change the domain without a redirect from the old one.
   - Receipts go through the notifications cron, like confirmations, so SMS and email must be configured. Make sure the A2P 10DLC campaign covers transactional receipts.
12. Turn on Neon point-in-time restore. Load the real data with the Squire importer (see the README), not the seed.
13. Add the custom domain under **Settings → Domains**.

## Running the production build locally

```bash
DEMO_MODE=true pnpm build
DEMO_MODE=true pnpm start   # http://localhost:3000
```

`pnpm db:deploy` runs the same migrate-then-maybe-seed step the Vercel build runs.
