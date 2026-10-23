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
   | `NOTIFICATIONS_*` | leave `disabled` until the shop goes live (see the README's cutover plan) |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | the Twilio account, for texts, call-in calls and the shop line. Set `NOTIFICATIONS_SMS_PROVIDER` and `NOTIFICATIONS_VOICE_PROVIDER` to `twilio` when the shop goes live. |
   | `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM` | optional fallbacks for shops without their own Twilio number |

   Don't set `DEMO_MODE`. Without it the build only ever applies migrations. It never seeds.
3. Deploy. The build applies migrations. To run them yourself instead, set `SKIP_DB_MIGRATE=true` and run `DATABASE_URL_UNPOOLED=… pnpm db:migrate`.
4. Set up Stripe:
   - Turn on **Connect** for the platform account (Express accounts; the platform pays the fees and covers losses). Add the brand's bank account to the platform account. Shops set to **Brand account** are paid out there.
   - Turn on **Terminal**. The app creates one Terminal Location per shop from its address the first time a reader is registered there. Readers are registered with the code they show, under **Shop settings → Card readers**.
   - Point a Stripe webhook at `https://<your domain>/api/stripe/webhook` for `charge.refunded`, `charge.dispute.created`, and `payout.created`, `payout.updated`, `payout.paid`, `payout.failed` and `payout.canceled` (the brand account's own payouts). Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
   - Add a second webhook, set to **listen to events on connected accounts**, at `https://<your domain>/api/stripe/connect` for `account.updated`, `capability.updated`, `account.external_account.created`, `account.external_account.updated`, `account.external_account.deleted`, `account.application.deauthorized`, and the same five `payout.*` events. Copy its signing secret into `STRIPE_CONNECT_WEBHOOK_SECRET`.
   - Then open **Location setup** for each shop. Under **Payments and banking**, the Brand Owner (or someone they've given the banking permission) picks the shop's own Stripe account, the brand account, or cash only. For the shop's own account, they finish Stripe's onboarding, where Stripe collects the legal entity, EIN, owner identity and bank. The app keeps only the Stripe account ID and the status Stripe reports. A shop on its own account takes cards only once Stripe enables charges.
5. Set up Twilio (when texts and calls go live):
   - Buy a number per shop and enter it under **Shop settings → Twilio number**. Calls to it ring the shop's phone; missed and after-hours calls get a text with a booking link.
   - For each number, point the messaging webhook at `https://<your domain>/api/twilio/sms` and the voice webhook at `https://<your domain>/api/twilio/voice` (HTTP POST). The app sets the status and call-flow webhooks itself. All are verified with `X-Twilio-Signature`, so `APP_BASE_URL` must match the domain Twilio calls exactly.
   - Register the numbers for A2P 10DLC (brand and campaign) before texting clients; carriers filter unregistered texts.
6. Set up the time clock, per shop, under **Payroll → Time clock setup**:
   - Enter each shop's latitude and longitude (the seeded ones are approximate, city-level) and its public IP address. While on the shop Wi-Fi, the page shows the address you're connecting from.
   - The network check reads the first entry of `x-forwarded-for`, which Vercel sets to the client's address. Behind any other proxy, make sure it sets that header and that clients can't spoof it, or use the device or GPS check instead.
   - Register each front-desk iPad from **Front-desk clock** on the iPad itself. The seeded devices can't be used.
   - Have each person set their PIN on **Time clock**. The seed's demo PIN only exists in seeded data.
   - The notifications cron (every 5 minutes) also flags forgotten clock-outs, and once a night around 3 AM shop time it checks full-time and part-time crossings. Nothing else needs scheduling. On the Hobby plan's daily cron, forgotten clock-outs are flagged once a day and the FT check only runs if that daily run lands between 3:00 and 3:15 AM.
7. Turn on Neon point-in-time restore. Load the real data with the Squire importer (see the README), not the seed.
8. Add the custom domain under **Settings → Domains**.

## Running the production build locally

```bash
DEMO_MODE=true pnpm build
DEMO_MODE=true pnpm start   # http://localhost:3000
```

`pnpm db:deploy` runs the same migrate-then-maybe-seed step the Vercel build runs.
