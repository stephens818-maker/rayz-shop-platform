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

**Vercel plan.** The reminder queue runs every 5 minutes on Vercel Cron, which needs **Vercel Pro**. Pro is also what Vercel's terms require for a business. On the free Hobby plan, a deploy with a cron more frequent than daily is rejected. To try the demo on Hobby anyway, change the three schedules in `vercel.json` (notifications every 5 minutes, Campaign Center every 15, the Morning Dashboard every minute from 4 AM to noon Central) to `"0 12 * * *"` (once a day). The demo doesn't send anything, so nothing is lost.

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
- **Receipts:** after paying, choose **Text** or **Email** on the ticket. With a Google review link set under **Shop settings → Receipts**, the receipt shows **Leave a review**; its clicks are in **Reports → Google review links**. The text is under **Notifications** (suppressed); open its `/receipt/…` link on a phone. Refund the ticket and the same link shows the refund, and an updated receipt is queued. Clients ask for copies at `/receipt`.
- **Gift card and promo:** `DEMO-GIFT-2500` holds $25, and `WELCOME5` takes $5 off.
- **We have openings:** sign in as `coralville@rayz.test`, open **Campaign Center → We have openings**, pick a barber and today or tomorrow, and watch the preview: open times, how many would get it, and the message. Nobody qualifies until the consent columns exist, so the send is skipped as "No marketing consent". The live page is the link in the history.
- **Campaign Center:** as the owner, make a coupon under **Promos & gift cards** (say a free beard trim), set the postal address under **Campaign Center → Settings**, then attach the coupon to **We miss you** under **Campaign Center → Campaigns** and switch it on at Coralville. Or build a blast under **Campaign Center → Blasts** (say "more than 3 weeks" with a barber), watch the count update, and **Send now**; or start a lapsed sequence from **Campaign Center → Campaigns**. The seed has no marketing consent (those columns come from the customer app), so clients are skipped as "No marketing consent" until they exist; **Test send** to yourself by email still works, and every message shows under **Notifications** as suppressed. Open `/book/coralville?coupon=<code>` to see a coupon applied in online booking.
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
   | `TWILIO_ADVANCED_OPT_OUT` | optional: `1` if the Messaging Service's Advanced Opt-Out answers HELP (put the brand's HELP text there too); otherwise the app answers HELP with the text from **Campaign Center → Settings** |
   | `NOTIFICATIONS_PUSH_PROVIDER` | app push for the Campaign Center: `disabled` (default), `console`, `simulator`, or `expo` (a stub until the app's push credentials exist) |
   | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | optional: the language model behind Rayz Assistant (step 17). Without either, production has no assistant. |
   | `ASSISTANT_PROVIDER` | optional: `openai`, `anthropic`, `stub` (the keyword demo) or `off`. Unset, it uses whichever key is set, OpenAI first. |
   | `ASSISTANT_MODEL` | optional: the model name (defaults `gpt-4.1-mini` for OpenAI, `claude-sonnet-4-5` for Anthropic) |

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
   - Receipt links are built from `APP_BASE_URL`, so set it to the public domain before texts or emails go live, or every link points at the wrong host. Links never expire, so don't change the domain without a redirect from the old one.
   - Receipts go through the notifications cron, like confirmations, so SMS and email must be configured. Make sure the A2P 10DLC campaign covers transactional receipts.
12. Set up Google reviews (migration `core_0039_google_reviews`; see [Google reviews](README.md#google-reviews)):
   - The migration adds the click log, the review follow-up to the receipt history, and **Google review links** report permissions for Brand Admin, Regional Manager and Shop Manager. A review link saved before that isn't Google's stops showing (no button) until it's replaced.
   - For each location, open Google Business Profile → **Ask for reviews**, copy the `g.page/r/…` link, and paste it under **Shop settings → Receipts → Google review link** (a write-review link or the Place ID also works). The field shows where clients will go.
   - The follow-up is off everywhere until a location turns it on. It runs on the notifications cron, so SMS and email must be configured; on the Hobby plan's daily cron it goes out once a day (tickets from the last day, outside quiet hours), not a few hours after each visit.
   - Review texts go out under the shop's A2P 10DLC campaign: make sure its use case and sample messages cover them. Don't add a "were you happy?" step in front of the link; Google treats that as review gating.
   - Migration `core_0040_review_visits` adds the brand's review rules. From then on the button and follow-up start at a client's 3rd visit and pause 90 days after a tap at that location; set them under **Shop settings → Google reviews** (owner or brand admin), or per location under Receipts. Clients with imported Squire history already count it, so most regulars qualify on day one.
13. Set up the Campaign Center (migrations `core_0041_marketing`, `core_0042_campaign_center`, `core_0043_lapsed_campaigns` and `core_0045_openings`; see [Campaign Center](README.md#campaign-center)):
   - The first migration adds coupon rules to promo codes, single-use codes, redemptions, coupons held from online booking, campaigns, sends, unsubscribes, unfinished online bookings and client tags. Existing promo codes keep working as shared codes that stack.
   - Together they give Brand Admin, Regional Manager and Shop Manager **Campaign Center: view**, **create** and **send**, and the **Campaign Center** report. Nobody but the Brand Owner gets **Campaign Center: export** until it's granted. The second migration also renames any custom role or per-person override that had the module's first permission names, so run both.
   - The third adds lapsed sequences (steps, and which step each message was) and gives the same roles **Campaign Center: own lapsed clients** and the **Lapsed clients by barber** report. Barbers don't get it: to let barbers see and message their own lapsed clients, turn it on for the Barber role (or per person) in **Permissions**, and switch on **From your barber** under **Campaign Center → Campaigns** at the locations that allow it. Sequences start off; nothing is sent until someone switches one on.
   - Every campaign starts off at every location, so nothing is sent until someone switches one on. Set the brand's postal address under **Campaign Center → Settings** first; no marketing email goes out without it (CAN-SPAM). Check quiet hours (9 PM to 9 AM by default), the weekly and monthly limits, the HELP text and the per-message costs for the report.
   - `vercel.json` runs `/api/cron/campaign-center` every 15 minutes with `CRON_SECRET`, like the notifications cron. On the Hobby plan's daily cron, campaigns go out once a day and messages queued in quiet hours wait for the next run.
   - **Texts:** marketing texts need marketing consent from the customer app (`sms_marketing_opt_in`, PR #8). Until those columns exist nobody qualifies. Register the A2P 10DLC campaign with a marketing use case (with sample messages that say "Reply STOP to opt out.") before any location turns a campaign on. If you use Twilio Advanced Opt-Out, set `TWILIO_ADVANCED_OPT_OUT=1` and copy the HELP text into the Messaging Service.
   - **Email:** use Postmark's broadcast stream or Resend with a verified domain. Both providers are stubs today, so they need wiring before go-live (see the README's Next steps).
   - **Coupon checks** on online booking are limited per client IP. On Vercel that's `x-real-ip`; self-hosted, set `TRUSTED_PROXY_HOPS` (see step 9), or the limiter is skipped because the IP is unknown.
   - Tracked links and unsubscribe links are built from `APP_BASE_URL` and never expire, so set it to the public domain first and don't change it without a redirect.
   - **Migration `core_0045_openings` changes who has the Campaign Center.** Locations (Regional Manager, Shop Manager, Front Desk and shop logins) get only **We have openings** and its report. It takes coupons (`promos.manage`), **Campaign Center: view, create, send, own lapsed clients** and the Campaign Center and lapsed-client reports out of the Regional and Shop Manager roles. Custom roles and per-person grants are left as they are. If managers should keep any of it, grant it back under **Permissions** (role editor or per person) after migrating.
   - Under **Campaign Center → Settings → We have openings**, check the per-client window (one openings message per 7 days), each location's daily and weekly send limits (3 and 12), whether the brand approves sends first, and the wording. Approvals are under **Campaign Center → We have openings** for anyone with **Campaign Center: send** and access to all shops.
14. Client search and filters (migration `core_0044_client_search`; see [Client search, filters and saved searches](README.md#client-search-filters-and-saved-searches)):
   - The migration adds client numbers (from 10001), nickname, source, referred-by, photos, saved searches, duplicate dismissals, zip points, the fuzzy-search name and the zip and town read from the address. It also adds SHA-256 lookup hashes of phone, email, birthday and address, kept by a trigger. It fills the hashes by touching every client row once, so run it at a quiet time on a large book.
   - It gives Brand Admin, Regional Manager, Shop Manager and Front Desk **Use advanced client filters** and **Save client searches and share them**. **Export the client list** stays with the Brand Owner until granted.
   - Load zip centers for "within N miles": download the Census ZCTA gazetteer (`2024_Gaz_zcta_national.zip` from census.gov), unzip it, and run `MIGRATE_DATABASE_URL=<unpooled URL> pnpm tsx scripts/load-zip-points.ts 2024_Gaz_zcta_national.txt`. Re-running updates it. Without it, distance filters match nobody unless the shop has coordinates and the client's zip is loaded.
   - Set `AUTH_SECRET` before printing or texting loyalty cards: the card's signature is made with it, so changing it invalidates every card.
   - After the Squire import, clean up under **Clients → Duplicates → Imported from Squire**.
15. The Morning Dashboard email (migration `core_0046_morning_dashboard`; see [Morning Dashboard](README.md#morning-dashboard)):
   - The migration adds the **Morning Dashboard** report (view and export) to Brand Admin, Regional Manager and Shop Manager, an HTML part for queued emails (scrubbed like the text part), and `morning_dashboard_sends`, which records each person, version and channel sent each morning so it never goes twice.
   - `vercel.json` runs `/api/cron/morning-dashboard` every minute from 09:00 to 17:59 UTC, which is 4 AM to noon Central in summer and winter, with `CRON_SECRET`. The notifications cron also tries it every 5 minutes as a fallback. If you change the schedule, keep it running through the brand's send time; nothing goes out after noon.
   - It goes out at 7:02 AM by default to Brand Owner, Brand Admin, Regional Manager and Shop Manager. Check **Setup → Morning Dashboard email** before the first morning: who gets it, the all-locations or single-shop versions per person, the sections, and the PDF and text options (both off).
   - Email needs Postmark or Resend wired with HTML parts (both providers are stubs today; see the README's Next steps). With no provider set, the emails are queued and shown in the outbox but not sent; `NOTIFICATIONS_EMAIL_PROVIDER=console` logs them instead. The text summary uses the transactional SMS sender, so make sure the A2P 10DLC campaign covers staff notifications.
   - Set `APP_BASE_URL` to the public domain: every link in the email is built from it.
16. Custom reports (migration `core_0047_report_builder`; see [Custom reports](README.md#custom-reports)):
   - The migration adds saved reports and their send log, and indexes on sales and appointments by client and on clients by created date and preferred barber. The indexes are built without `CONCURRENTLY`, so on a large database run it at a quiet time.
   - It gives Brand Admin, Regional Manager and Shop Manager all three **Custom reports** permissions (open, build, export). Exporting a customer report also needs **Export the client list**, which stays with the Brand Owner until granted.
   - Scheduled reports go out from the notifications cron (every 5 minutes), so nothing new goes in `vercel.json`. They need a real email provider like the Morning Dashboard; with none, they're queued in the outbox and not sent.
17. Rayz Assistant (migration `core_0048_assistant`; see [Rayz Assistant](README.md#rayz-assistant)):
   - The migration adds the assistant's settings, conversations, messages and drafts, and gives Brand Admin **Turn Rayz Assistant on or off for each role** (`assistant.settings`). The assistant starts on for every role but only appears once a provider is set. In production that means a key: the keyword demo runs there only with `ASSISTANT_PROVIDER=stub`.
   - Put `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the Vercel project's environment variables, never in the repo. Use a key for its own project or workspace with a spending limit.
   - **Data retention:**
     - OpenAI requests are sent with `store: false`. Ask OpenAI to turn on zero data retention for the key's organization as well, which also stops the 30-day abuse-monitoring logs.
     - Anthropic has no per-request switch and doesn't train on API inputs. Zero data retention is an agreement on the organization; ask Anthropic for it.
     - **Setup → Rayz Assistant** shows which provider and model are in use, never the key.
   - The model only receives scrubbed report text: no client phone, email, address, birthday, notes or custom fields, and nothing the person's **Client data** level hides.
   - Before go-live, check **Setup → Rayz Assistant**: the roles that get it, the per-person limits (6 a minute, 100 a day), and whether it may draft blasts and purchase orders. Every question and tool call goes in the audit log.
18. The shop login (migration `core_0049_shop_login`; see [The shop login, against Squire's](README.md#shop-login)):
   - The migration adds the drawer's opening balance per shop ($300 to start) and its paid in and out, ticket reassignments, the approving manager on refunds and voids, the phone operator settings and call fields, the shop-login cap on client contact details (masked to start) and each state's sales tax schedule. It adds the **Shop Login** role and gives Brand Admin, Regional Manager and Shop Manager **Reassign a paid ticket**, **See staff phone numbers and email addresses** and the six new reports; Brand Admin also gets the five per-part shop settings permissions. Front Desk gets the End of day report.
   - **Existing shop logins keep their role.** Under **Permissions**, change each shop login to **Shop Login** (or set the role when resetting it under **Setup → Shop logins**). Whatever its role, a shop login now never refunds, voids or reassigns without a manager's PIN, reveals or exports clients, or sees staff contact details.
   - **Refunds at the desk need a manager's PIN.** Each manager who approves refunds sets a time clock PIN (**Payroll → Time clock setup**, or **My time**). Without one they aren't offered as an approver.
   - **Front Desk loses staff contact details.** Front Desk and Barber never had **See staff phone numbers and email addresses**, so staff phones and emails now show masked to them. Grant it per person if someone at the desk needs it.
   - Set each state's sales tax schedule under **Shop settings → Sales tax filing** (Iowa monthly, others quarterly to start). The saved sales tax report for each state follows it.
   - The phone operator is off at every shop until turned on under **Shop settings → Phone operator**; it needs the shop's Twilio number and adds the webhook `https://<your domain>/api/twilio/voice/operator`, which the app sets itself in the call flow (nothing to configure in Twilio). Try it first in the call simulator.
19. Turn on Neon point-in-time restore. Load the real data with the Squire importer (see the README), not the seed.
20. Add the custom domain under **Settings → Domains**.

## Running the production build locally

```bash
DEMO_MODE=true pnpm build
DEMO_MODE=true pnpm start   # http://localhost:3000
```

`pnpm db:deploy` runs the same migrate-then-maybe-seed step the Vercel build runs.
