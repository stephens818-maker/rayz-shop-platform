# NOTES-SYNC

Working notes between the two agents on this repo. The **core agent** (this branch, `cursor/rayz-barbershop-v1-8f0b`, PR #1) updates this file on every push. The **mobile agent** (`bc-645fbcc0-ed66-58c5-a7b9-f578411fa9e1`) opens PRs into this branch. The newest entry goes at the top of the log.

## Who owns what

| Area | Owner |
| --- | --- |
| Everything under `src/app/api/v1/**`, plus `src/server/api.ts`, `src/server/api-schemas.ts` and `src/server/openapi.ts` | mobile (bc-645fbcc0) |
| Customer auth and OTP: `src/server/auth/customer.ts`, `src/app/api/v1/auth/**` | mobile |
| Devices and push, consent, account deletion | mobile |
| Stripe Customer and saved cards (PaymentMethods attached to platform Customers) | mobile |
| `src/server/importer.ts` (Squire import) | mobile |
| Mobile workstream C1–C22 and I1–I16, except where noted below | mobile |
| Admin back office (`src/app/admin/**`), booking engine (`src/server/booking.ts`, `src/domain/availability.ts`, `src/domain/timing.ts`), POS and checkout, refunds, reports, inventory, permissions and roles, client data protection, notifications back office | core |
| Card fee config and `computeCardFee` | core (mobile reads only) |
| I10 Stripe Connect: platform account, connected account per shop, destination charges, onboarding, per-shop P&L | core, except the platform Customer and saved-card side, which is mobile's |
| Payroll (`src/domain/payroll/**`, `src/server/payroll/**`, `src/app/admin/payroll/**`) and service times (`src/domain/service-times.ts`, `src/server/service-times*.ts`) | core |

Neither agent edits the other's files. If you need a change in the other side's file, put it under "Requests" below or in a PR comment.

## Rules both sides follow

- **Migrations are additive only.** Never rewrite, squash or renumber an existing migration. The core agent's new migrations are named `core_NNNN_<name>.sql` in `drizzle/` (the `_journal.json` tag matches the filename). The mobile agent uses its own prefix. Migrations up to `0019_slot_timing` already exist and stay as they are. The core side has since added `core_0020_stripe_connect`, `core_0021_service_times` and `core_0022_payroll`.
- `drizzle/meta/_journal.json` and the snapshots are shared. When both sides add a migration, merge the journal by keeping both entries in `when` order, and regenerate the latest snapshot with `pnpm db:generate` (it should produce no new SQL).
- Server actions return `{ ok: true, data } | { ok: false, error }` through `safe()` in `src/server/action.ts`. Errors are `AppError(code, message, details)` from `src/server/errors.ts`.
- Every change to records goes through `audit(actor, action, entity, entityId, details, shopId, tx?)` in `src/server/audit.ts`.

## Shared interfaces

### `computeCardFee`: `src/server/payments/card-fee.ts`

```ts
computeCardFee(
  shopId: string,
  funding: "credit" | "debit" | "prepaid" | "unknown" | null,
  amounts: { chargeCents: number; tipCents?: number }, // chargeCents = what goes on the card before the fee, tip included
  opts?: { wallet?: boolean },                         // Apple Pay / Google Pay
): Promise<{
  feeCents: number;
  rate: number;          // after clamping to 3%; 0 when no fee
  basis: "charge_excluding_tip" | "charge_including_tip";
  basisCents: number;    // what the rate was applied to
  waivable: boolean;     // true whenever a fee applies: a surcharge is the shop's option, never required
  reason: "applies" | "disabled" | "not_credit" | "wallet_fee_off" | "zero_amount";
  label: string | null;      // "Credit card surcharge (3%)"
  disclosure: string | null; // the legal text to show before charging
}>
```

- The math is the pure `cardFeeFor(config, funding, amounts, opts)` in `src/domain/checkout.ts`. The POS's `computeCheckout` uses the same function, so the app and the POS can't disagree. `tests/card-fee.test.ts` checks that.
- Fee config lives on `shops`: `card_fee_enabled`, `card_fee_rate` (numeric, fraction), and `card_fee_applies_to_tip`. Only people with `settings.taxes` change it, under Shop settings.
- Wallet payments get no fee while `FEATURE_WALLET_FEE` is off (the default; see flags below).

### Feature flags: `src/lib/flags.ts`

`flags.reviewLogin()` (C18, app store review login) and `flags.walletFee()` read `FEATURE_REVIEW_LOGIN` and `FEATURE_WALLET_FEE`. Both are off unless the variable is exactly `"true"`. Both decisions are still open with Charles, so leave them off.

### Permissions and roles

- Catalog: `src/domain/permissions.ts`. It has `FEATURE_PERMISSIONS`, `REPORTS` (each report gets `report.<key>.view` and `report.<key>.export`), `ROLE_TEMPLATES`, `OWNER_ONLY`, `BRAND_ONLY`, `effectiveAccess`, and the grant rules (`roleChangeDenied`, `userAccessChangeDenied`).
- Server checks are in `src/server/auth/staff.ts`:
  - `requireStaff()` and `authorize(perm | perms, message?)` return a `StaffContext` with `permissions`, `shopIds`, `brandWide`, `currentShopId` and `actor`.
  - `can(ctx, perm)` checks a single permission.
  - `assertShopAccess(ctx, shopId)` refuses a shop outside the caller's access.
  - `guardPage(page)` uses `PAGE_ACCESS` in `src/domain/navigation.ts`.
- `src/server/auth/access.ts` has `loadStaffAccess(staffId)`.
- Adding a permission: add it to `FEATURE_PERMISSIONS`, and to the templates that should have it. Then add a migration that appends it to the existing `roles` rows, for example `UPDATE roles SET permissions = permissions || '["x"]'::jsonb WHERE key IN (...) AND NOT (permissions ? 'x')`. Brand Owner gets everything automatically.
- Staff API routes (if mobile adds any): use `authorize()` and `assertShopAccess()` the same way the admin actions do. `tests/db/tenant.test.ts` tries every action against another shop's records and must keep passing.

### I10 Stripe Connect (core)

One Ray'z platform account, and one Express connected account per shop. The platform carries fees and losses (`controller.fees.payer = application`, `losses.payments = application`), and Stripe collects the requirements. Code: `src/domain/connect.ts` (pure: states, fee schedule, labels), `src/server/payments/connect.ts` (accounts, onboarding, destination, payouts), `src/server/payments/connect-webhook.ts` and `src/app/api/stripe/connect/route.ts`.

- **`chargeCard(opts)`** in `src/server/payments/processor.ts` is still the only place a PaymentIntent is created. New optional inputs:
  - `destination: { accountId, applicationFeeCents }`. With it, the charge sets `on_behalf_of` and `transfer_data.destination` to the shop's account, and `application_fee_amount`.
  - `customerId`: the platform Stripe Customer (mobile's), so a saved card pays at any shop.
  - It returns `destination`, `chargeId`, `transferId` and `processorFeeCents` (from the balance transaction) as well.
- **`chargeDestination(shop, amountCents, "keyed" | "terminal")`** in `src/server/payments/connect.ts` gives the destination for a charge at a shop. If the shop's account can't take charges, it throws `AppError("payment_failed", <message>, { reason: "payments_not_ready", state })`, where `state` is one of `not_started | onboarding | in_review | restricted | disconnected`. I used `payment_failed` because `ErrorCode` lives in `api-schemas.ts` (mobile's). If you'd like a dedicated `payments_not_ready` code in the API, add it on your side and map `details.reason`.
- **Application fee** = the processing fee estimate: `CONNECT_FEE_KEYED` (default `2.9%+30`) for keyed and online, `CONNECT_FEE_TERMINAL` (default `2.7%+5`) for the reader. It is not returned on refunds.
- **Refunds:** `refundCard(pi, amount, key, { reverseTransfer: true })` for any payment with a `stripe_account_id`. It sends `reverse_transfer: true` and `refund_application_fee: false`.
- **Schema** (`drizzle/core_0020_stripe_connect.sql`):
  - `owner_entities` (`kind` is `brand` or `franchisee`) and `shops.owner_entity_id`. This is the S4 grouping; a franchisee can own several shops.
  - `shop_payment_accounts`: one row per shop. It has `stripe_account_id` (unique), `simulated`, `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements_due`, `disabled_reason` and `deauthorized_at`.
  - `shop_payouts`: from the `payout.*` webhooks, keyed on `stripe_payout_id`.
  - `payments` gains `stripe_account_id`, `application_fee_cents`, `processor_fee_cents`, `stripe_charge_id` and `stripe_transfer_id`.
  - New permissions: `payments.accounts` (brand-only) and the report `shop_accounts`.
- **Env:** `STRIPE_CONNECT_WEBHOOK_SECRET` is the signing secret of a separate **Connect** webhook endpoint at `/api/stripe/connect` (events `account.updated`, `account.application.deauthorized`, `payout.*`).
- **Without keys:** accounts are `sim_acct_…`, and onboarding is a stand-in page. Simulated accounts are refused in Stripe mode, so a shop has to onboard for real once keys are set.

### Payroll (core)

Spec: [`docs/payroll-report-spec.md`](docs/payroll-report-spec.md). Workbook problems: [`docs/payroll-workbook-discrepancies.md`](docs/payroll-workbook-discrepancies.md).

- **No iSolved connection.** Output is a per-shop xlsx in the workbook's exact format, downloaded after approve-and-lock and uploaded by hand. Nothing calls iSolved. Exports go through `PayrollExporter` in `src/server/payroll/export.ts`.
- **Employee Numbers are sensitive.** `payroll_profiles.employee_number` lives in the database only. Please never return it from `/api/v1` or put it in logs, push payloads or fixtures.
- **Schema** (`drizzle/core_0022_payroll.sql`): `pay_groups` (one per shop, each with its own calendar and legal entity), `payroll_profiles`, `payroll_rates`, `time_entries`, `payroll_overrides`, `payroll_runs` (locked snapshots), `payroll_locked_ot`, and `brand_settings.payroll` (jsonb). New permissions `payroll.run` and `payroll.approve` (brand-only, added to Brand Admin).
- **Sales and tips** come from `payrollSalesBetween` in `src/server/reports.ts`, so a ticket counts at the shop it was rung up at, same as the reports.
- Service times (`drizzle/core_0021_service_times.sql`): `appointment_times` records arrival, start, finish and checkout, each with who recorded it. The mobile side doesn't need to write it; check-in through the API can set arrival later if you'd like it.

### Brand-to-shop settings ("brand-sync registry")

There's no module by that name yet. These are the places where a brand setting flows down to shops today:

- **Catalog:** `services` and `products` hold the brand records. `shop_services` and `shop_products` hold each shop's price, duration, enabled flag and stock. `catalog.manage` pushes brand items to shops.
- **Booking times:**
  - Interval precedence is in `resolveInterval` in `src/domain/timing.ts`: barber at shop, then barber, then shop, then brand (`brand_settings.slot_interval_minutes`).
  - Duration precedence is in `resolveDuration`: barber at shop, then barber, then the shop menu, then the service default.
- **Loyalty:** brand-wide, in `brand_settings`.
- **Client data protection:** brand policy, with per-role and per-person rules.

If the mobile side means a specific registry from the plan, say which items it should cover and the core agent will build it.

### Schema notes the mobile side may read

- `appointments`:
  - `busy_from` and `busy_until` are set by a trigger from `buffer_before_minutes` and `buffer_minutes`.
  - The `appointments_no_double_booking` constraint stops service times overlapping. `appointments_no_buffer_overlap` stops buffers overlapping, unless the booking has `squeezed = true`.
  - Online and API bookings must start on a time from `getAvailability`, which is per barber now (`slot.ends[staffId]`). Squeeze-in is staff-only.
- `payments` gains Connect columns. See the I10 section above.

## Requests for the other agent

- (core → mobile) When you add the platform Stripe Customer and saved cards, pass the platform Customer id into `chargeCard({ customerId, paymentMethodId, ... })` in `src/server/payments/processor.ts`. That function routes the charge to the shop's connected account (I10), so a saved card can pay at any shop. Please don't create PaymentIntents anywhere else.
- (core → mobile) An app checkout or prepayment for a shop that isn't onboarded fails with `payment_failed` and `details.reason = "payments_not_ready"`. Please show that as "This shop isn't taking cards in the app yet" instead of as a card decline.

## Open questions

- Which C/I/S items does "brand-sync registry" refer to? See above.
- C18 review login and the wallet fee: flags are off until Charles decides.
- I10 fee model: the platform keeps an application fee equal to the processing estimate, and doesn't return it on refunds, so each shop's P&L carries its own card cost. Charles to confirm, or name a platform margin on top.
- Payroll, pending Charles: Q11 (do clocked hours already include training? The C2 flag stays off), Q17 (the owner row and the Coralville NetComm gap, flagged and not fixed), the full-time hours basis and window (default: clocked worked hours over a rolling 4 weeks), and 2-decimal half-up rounding of the export (off).

## Log

### 2026-10-23: core (staff time)

- **My time** at `/admin/my-time`, for a phone. It has quick blocks (lunch, break, personal, other) with a start and a length, recurring blocks with skip and stop, one-tap lunch now, time off requests (a day, a range or part of a day, at one shop or all), and the barber's requests with their status.
- **Time off** at `/admin/time-off`, per shop:
  - Pending requests to approve or deny, with the booked appointments in them.
  - Approved time off coming up, where an appointment can be moved to a free barber at the same time or the client asked to reschedule (`time_off_reschedule`). Appointments are never cancelled.
  - A month calendar, who's off, recently decided, and the rules (approval mode, longest lunch, longest block, minimum notice), per brand with shop overrides.
- Blocks and requests over booked appointments warn first and need a confirm. Automatic approval happens only when nothing is booked. Pending time off is held from online booking.
- The calendar's block panel gained categories, and the calendar shows an "Off today" banner. The dashboard has a "Who's in today" card. There's a new **Who's working, off and blocked** report (`staffing`).
- Migration `core_0023_staff_time`. The template grants are listed by role key. Custom roles get `blocks.own`, and `blocks.others` if they could already manage the calendar or schedules.
- **Seed:** brand rules, with Moline set to automatic approval. Makenna has a recurring lunch made from her seeded 12:30 lunches, so the sample history is unchanged. The seed also has time off requests in every state, kept off the Coralville days the booking tests use.
- **Fixes to existing tests, both date-dependent:**
  - `scripts/squire-fixture.ts` looped forever when five days before the export date was a Sunday (as it is from 2026-10-23).
  - The review test P2#24 squeezed in seven minutes before the last slot even when the barber had a client then.
- Tests: `tests/staff-time.test.ts` and `tests/db/staff-time.test.ts`. The permission template and navigation tests were updated for the new permissions.
- **Not touched:** anything under `/api/v1` (availability now honours pending time off; see Staff time above).

### 2026-10-23: core (payroll)

- **Payroll Report** at `/admin/payroll/report`: the workbook's Locations math row for row, plus O.T. Pay (1.5 × base × split OT hours), Training Pay and Labor Cost as real cost. Includes the Locations view, per-employee drill-down, anomalies, a reconciliation gate that blocks approve-and-lock on any $0.01 mismatch, and downloads of locked periods only.
- **Cross-shop OT (C4):** per Sun–Sat America/Chicago workweek, across every shop of the same legal entity (default Ray'z Inc.), split by share of hours, across pay periods and DST weeks. Locked periods keep their OT.
- **Per-shop pay groups and calendars.** The main shops are on period 23 = 10/18–10/31 (check 11/6). Dubuque has its own calendar (period 01 = 10/4–10/17, check 10/23) and its own export file, which resolves Q16.
- **iSolved export:** a per-shop xlsx with the same columns, headers and codes as the workbook (including `E_Cash Tips Recd_Dollars`). It carries OT hours only, never OT dollars, unrounded by default, and copies each tab's formatting cell for cell. There's no iSolved API; the export is behind `PayrollExporter`.
- **Declined by Charles (keep iSolved as-is):** C1 blended-rate OT and C3 moving card tips off Cash Tips Recd. Neither is built and there are no flags for them.
- Also added Payroll → Hours (time entries plus shift CSV import) and Payroll → Setup (settings, pay groups, profiles and rates).
- Migration `core_0022_payroll`; the seed adds sample payroll data with synthetic Employee Numbers.
- Tests: `tests/payroll-engine.test.ts`, `tests/payroll-export.test.ts`, `tests/payroll-time-csv.test.ts`, `tests/db/payroll.test.ts`.
- Docs: `docs/payroll-report-spec.md` and `docs/payroll-workbook-discrepancies.md` (anonymized).
- **Service times:**
  - The `appointment_times` table, capture through status changes and checkout, manager corrections with audit, outlier flags, duration suggestions. Migration `core_0021_service_times`.
  - Start and Finish are in the calendar panel, on the barber's Up next list and on the checkout screen. The calendar panel's old "In chair" button is now Start.
  - Added the Service times report page (`/admin/reports/service-times`) with **Use N min**.
  - Fixed: Finish and checkout's stand-in Finish used to fail the `appointment_times_order` check. Postgres checks an upsert's insert row before it sees the conflict, so writes now update first and insert only when there's no row.
  - Tests: `tests/service-times.test.ts` and `tests/db/service-times.test.ts`.
  - `vitest.config.mts` turns off Vitest's on-disk module cache, which was serving a stale page list to the page-rendering tests.
- **Not touched:** anything under `/api/v1`.

### 2026-10-23: core (I10 Stripe Connect)

- Added a connected account per shop, destination charges, transfer reversal on refunds, and a refusal to charge cards at shops that aren't onboarded.
- Added a location setup wizard at `/admin/setup`, with Stripe-hosted onboarding, or a simulator stand-in when there are no keys.
- Added owner entities, the Connect webhook, and the "Shop P&L by Stripe account" report.
- Migration `core_0020_stripe_connect`.
- The seed now gives every shop a simulated, onboarded account, and routes its card history there.
- Tests: `tests/connect.test.ts` and `tests/db/connect.test.ts`. The setup actions are now in the tenant test.
- **For mobile to review:** the `chargeCard` contract and the `payments_not_ready` error above.
- **Not touched:** everything under `/api/v1`, the platform Customer and saved cards, consent, devices and push, and `importer.ts`.

### 2026-10-23: core

- **Booking times:**
  - Brand, shop, and per-barber-per-shop slot intervals.
  - Service timing: duration step, booking increment, prep and cleanup.
  - Shop and barber durations.
  - The day calendar draws each barber's own grid, with drag-and-drop.
  - A squeeze-in that needs a permission and is audited.
  - New permissions `scheduling.timing` and `calendar.squeeze_in`. Migration `0019_slot_timing`.
- **Card fee:** added `computeCardFee` (`src/server/payments/card-fee.ts`), the pure `cardFeeFor` (`src/domain/checkout.ts`) and `src/lib/flags.ts`.
- Created this file.
- **Next:** I10 Stripe Connect (connected account per shop, destination charges with `on_behalf_of` and `transfer_data`, hosted onboarding in location setup, owner entities, and a per-account P&L report).
