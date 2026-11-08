# Ray'z mobile sandbox

Two Expo apps and a mock API that stand in for the shop platform. Everything for the apps lives in this directory. The Next.js platform is not modified from here.

- `apps/customer` — Ray'z, version 3.0.0, iOS bundle `com.getsquire.SquireRayzBarbershop`, Android package `com.rayzbs.app`
- `apps/staff` — Ray'z Team, version 1.0.0, bundle and package `com.rayzbs.team`
- `packages/api` — typed client for `/api/v1` and `/api/staff/v1`
- `packages/mock-api` — Hono server with the same routes, including pay, clock-in, and earnings
- `packages/ui` — shared layout, type, and English/Spanish copy

Amounts are integer cents. The apps format server amounts. They do not compute wages, overtime, or card fees beyond the published preview.

My Earnings is gross. The total is labeled **Gross earnings, before taxes and deductions**. There is no net-pay line. A pay period downloads as a payroll report file (CSV or PDF). Payroll status is **Not yet processed**, **Sent to payroll**, or **Paid in paycheck**.

## Run

From `mobile/`, with Node 20+ and pnpm 10:

```bash
pnpm install
pnpm dev:mock
```

The mock listens on port 8787. In two more terminals:

```bash
pnpm dev:customer
pnpm dev:staff
```

Customer web is http://localhost:8081. Staff web is http://localhost:8082. Press `i` or `a` in those Expo sessions for a simulator. No Apple, Google, Stripe, or Expo account is required for the sandbox.

Sandbox sign-in code is always `123456`.

| App | Phone | Then |
| --- | --- | --- |
| Customer family | (319) 555-0100 | Choose Alex or Jordan |
| Makenna (Coralville, tip deposits on) | (319) 555-0111 | PIN 135790 |
| Kat (Moline, tips through payroll) | (309) 555-0222 | PIN 246810 |
| Casey (Coralville and Moline) | (563) 555-0333 | PIN 111222 |
| Riley (deposits not started) | (319) 555-0444 | PIN 101010 |

Face ID only unlocks Ray'z Team. Clock-in is a rotating shop code, and the clock screen never asks for a face scan. On web, **Clock in** uses the current sandbox code.

The sandbox clock is America/Chicago. Workweeks are Sunday–Saturday (`weekStartDay` 0). Earnings presets (current period, last period, this week, last week, month to date) recompute from that date. Custom keeps the dates you picked. Sunday 2026-10-18 starts a new week.

Shops at launch of this sandbox:

- Coralville is the pilot: launched, native booking, cards, clock-in, and `tip_to_barber` on. Customer pay still says **Tips paid through payroll.** until charges stop using destination charges.
- Moline books and takes cards in the app. Its tip flag is off, so staff earnings say **Tips paid through payroll.**
- Kimberly is not launched. `/app/config` sets payments false, booking external (https://book.rayzbs.com/shops/kimberly), and clock-in false. A closed shop's pay preview is 200 with the closed sentence. Confirm is 403 `not_launched`.

## Test

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Covered: Sunday workweeks, Chicago ticket dates, card-fee mirror, earnings queries where a `staffId` param is 400, pay math that mirrors payroll (`computeLine`: greater of hourly or service commission, then product commission, training at the training rate, overtime estimated at 1.5× the hourly rate), the $210 golden line, 38 production hours + 4 training hours in the Sunday week of 2026-10-11, whole-week CSV/PDF export, `Cache-Control: private, no-store`, a 5-minute step-up, locked and exported snapshots, late cash tips that do not claw back, refunds that are not netted, gross payroll files, barber isolation, client cards that return a first name only, destination charges that hide tip transfers, sign-in that cannot pick an arbitrary profile, sticky SMS opt-out, receipt auth and pagination, pay confirm 403s, Stripe setup secrets, rebook on the barber grid, deletion OTP, live wait, a nullable loyalty badge, launch gates, and cash-tip attestation. Instant payout quotes keep `deductedFromTipsCents` at 0.

## Point the apps at the platform

```bash
EXPO_PUBLIC_API_URL=https://your-platform.example pnpm dev:customer
```

Use the same variable for the staff app. The apps send `X-Client` and `X-App-Version`. Staff earnings also send `X-Step-Up` after the app PIN.

Regenerate the customer types when the platform OpenAPI changes:

```bash
pnpm generate:api
```

That command needs the platform toolchain (`pnpm exec tsx` at the repo root) and writes `packages/api/openapi/v1.json` and `packages/api/src/generated/v1.ts`. The published OpenAPI components do not schema the customer routes, so the apps follow the hand-aligned types in `packages/api/src/types.ts`.

`EXPO_PUBLIC_STRIPE_PK` is optional. The app never collects a card number. Setup returns `clientSecret` and `ephemeralKey`. Brand and last4 come from Stripe's published test PaymentMethods. The pay button shows the fee before confirm. On a device, a live SetupIntent opens PaymentSheet with `customFlow` (FlowController). Web does not import the native SDK. Tokens on web are sealed in session storage, not localStorage.

## Stubbed on purpose

- Push tokens on web are a sandbox device id. Native requests notification permission and separates reminders from marketing.
- Face ID is the OS prompt on a device. Web unlock does not clock anyone in.
- Tip-deposit setup stores an embedded session secret and lets the sandbox mark a status. It does not collect a tax id or bank number. The app shows bank last4 only.
- No store submission and no EAS build.

## Platform routes these apps call that are not on the platform yet

Customer, beyond the published shops, services, barbers, availability, appointments, OTP, profile, and loyalty summary:

- `GET /api/v1/app/config`
- `GET /api/v1/me/home`
- `GET /api/v1/me/loyalty/ledger`
- `GET/POST/DELETE /api/v1/me/family`
- `POST/GET/DELETE /api/v1/me/payment-methods` and setup
- `POST /api/v1/appointments/:code/payment-preview`
- `POST /api/v1/appointments/:code/payments`
- `POST /api/v1/appointments/:code/rebook`
- `GET /api/v1/me/receipts`
- `POST/DELETE /api/v1/me/devices`
- `POST /api/v1/me/delete/start` and `confirm`
- `GET /api/v1/shops/:shop/live`
- Shop fields the apps read: `bookingMode`, `externalBookingUrl`, hours, phone, map coordinates

The whole staff API is still unbuilt on the platform. The apps assume:

- `GET /api/staff/v1/config`
- OTP start/verify, `POST /api/staff/v1/auth/step-up`, `GET /api/staff/v1/me`
- `GET /api/staff/v1/me/earnings`, `/days`, `/tickets`, `/pay-periods`
- `GET /api/staff/v1/me/earnings/report?format=csv|pdf`
- `GET /api/staff/v1/me/payouts`
- `POST /api/staff/v1/me/cash-tips`
- `GET /api/staff/v1/me/calendar`, appointment status, `GET /api/staff/v1/clients/:id`
- `GET /api/staff/v1/kiosk/qr`, `POST /api/staff/v1/clock/in` and `/clock/out`
- Payout account, embedded session, instant-payout quote and confirm, payout preferences
- `POST /api/staff/v1/me/devices`

Staff pay responses are gross cents plus `payrollStatus`: `not_yet_processed`, `sent_to_payroll`, or `paid_in_paycheck`. Period status also includes `exported`. Locked and exported periods are snapshots. The user comes from the token. A `staffId` query is a 400. Earnings responses send `Cache-Control: private, no-store`. The step-up token expires after 5 minutes. Payroll files export only a whole Sunday–Saturday week.

Customer profiles are first name only. SMS opt-out sticks: `PATCH /me` can turn texts off and cannot turn them back on. Family members start opted out. Receipts require auth; an unknown id is `{ receipt: null }`, refunds sit in `refunds[]`, and the list is `limit` plus `nextCursor`. Account deletion uses a real OTP. Live wait comes from chairs and the walk-in queue. The loyalty badge may be null.

Card charges in this sandbox keep the separate-charges field for service and tax. Customer pay preview tip disposition stays `payroll` with **Tips paid through payroll.** Staff earnings show a tip transfer only when one exists and the shop is not on destination charges. The apps do not change platform payment code.

iOS privacy manifests live in `apps/customer/ios/PrivacyInfo.xcprivacy`, `apps/staff/ios/PrivacyInfo.xcprivacy`, and each app's `ios.privacyManifests` so prebuild includes them. Face ID only unlocks Ray'z Team.
