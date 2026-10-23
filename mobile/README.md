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
| Customer family | (319) 555-0100 | Choose Alex or Jordan Reyes |
| Makenna (Coralville, tip deposits on) | (319) 555-0111 | PIN 135790 |
| Kat (Moline, tips through payroll) | (309) 555-0222 | PIN 246810 |
| Casey (Coralville and Moline) | (563) 555-0333 | PIN 111222 |
| Riley (deposits not started) | (319) 555-0444 | PIN 101010 |

Face ID only unlocks Ray'z Team. Clock-in is a rotating shop code, and the clock screen never asks for a face scan. On web, **Clock in** uses the current sandbox code.

The sandbox clock is America/Chicago. Earnings presets (current period, last period, this week, last week, month to date) recompute from that date. Custom keeps the dates you picked.

Shops at launch of this sandbox:

- Coralville is the pilot: native booking, cards, clock-in, and tip deposits
- Moline books and takes cards in the app, but tip deposits are off: **Tips paid through payroll.**
- Kimberly is not live in the app. Booking opens https://book.rayzbs.com/shops/kimberly

## Test

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Covered: preset dates in Chicago, card-fee mirror, earnings queries with no `staffId`, greater-of edges, training outside greater-of, 38 production hours + 4 training hours = 2 overtime hours, a workweek that posts into two periods, partial-week label `Estimated: full workweek not in range.`, locked snapshots, late cash tips that do not claw back, refunds that are not netted, gross payroll files, barber isolation, two shops, every transfer and payout status, sign-in, booking, fee disclosure, payout state machine, clock-in, and cash-tip attestation. Instant payout quotes keep `deductedFromTipsCents` at 0.

## Point the apps at the platform

```bash
EXPO_PUBLIC_API_URL=https://your-platform.example pnpm dev:customer
```

Use the same variable for the staff app. The apps send `X-Client` and `X-App-Version`. Staff earnings also send `X-Step-Up` after the app PIN.

Regenerate the customer types when the platform OpenAPI changes:

```bash
pnpm generate:api
```

That writes `packages/api/openapi/v1.json` and `packages/api/src/generated/v1.ts`. Routes the platform does not publish stay hand-typed in `packages/api/src/types.ts`.

`EXPO_PUBLIC_STRIPE_PK` is optional. The sandbox never asks the app to read a card number. Test cards are Visa credit ••4242, Mastercard debit ••5556, and a wallet instrument. A real SetupIntent would open Stripe's sheet.

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

Staff pay responses are gross cents plus `payrollStatus`: `not_yet_processed`, `sent_to_payroll`, or `paid_in_paycheck`. The user comes from the token. A `staffId` query is a 404.

Card charges in this sandbox are separate charges and transfers: service and tax to the shop, tips to the barber when that shop's flag is on. The platform checkout still uses destination charges. The apps follow the approved separate-charges contract and do not change platform payment code.
