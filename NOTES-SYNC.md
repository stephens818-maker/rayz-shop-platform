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
| I10 Stripe Connect per shop: `stripeAccountId`, hosted onboarding, destination charges, the `owner_entity_id` hook, and the one charge path every card payment goes through | mobile (bc-645fbcc0), reassigned 2026-10-26. The POS calls mobile's published charge path; it doesn't keep a second one |
| Per-location banking screens around Connect (payments mode, descriptor, Terminal Locations and readers, payouts) and per-shop P&L | core, reading mobile's Connect records |
| Payroll (`src/domain/payroll/**`, `src/server/payroll/**`, `src/app/admin/payroll/**`) and service times (`src/domain/service-times.ts`, `src/server/service-times*.ts`) | core |
| Time clock and timesheets (`src/domain/time-clock.ts`, `src/server/time-clock*.ts`, `src/server/labor-report.ts`, `src/app/admin/clock/**`, `src/app/admin/timesheets/**`, `src/app/admin/time-clock/**`) | core |
| Tip payouts (`src/domain/tips.ts`, `src/server/tips/**`, `src/app/admin/tips/**`, `src/app/admin/my-tips/**`), including employees' Stripe Express accounts | core |
| Money movement between Stripe accounts after a charge (`src/server/payments/money-movement.ts`). Since 2026-10-27 it's an abstract interface (`MoneyMovement`) with no transfer path: Stripe can't transfer from a shop's connected account to a barber's, and the flow is being redesigned as separate charges and transfers (ST-C11), pending Charles | core owns the interface and the tip side; the ST-C11 implementation is mobile's (bc-645fbcc0, it owns Connect charges), registered with `registerMoneyMovement`. See Requests |
| Staff sign-in restrictions (`src/domain/network-access.ts`, `src/server/auth/network.ts`, `src/server/sign-in-security.ts`, `src/middleware.ts`, `src/lib/client-ip.ts`, `src/app/admin/sign-in-security/**`) | core |
| Customer screen at checkout and split tips (`src/domain/handoff.ts`, `src/server/handoff.ts`, `src/server/auth/handoff-lock.ts`, `src/app/handoff/**`) | core |
| Digital receipts (`src/domain/receipts.ts`, `src/server/receipts.ts`, `src/app/receipt/**`, the ticket's receipt panel). The consent itself (opt-ins, wording, STOP) stays mobile's; receipts only read it | core |
| The staff app's API, `/api/staff/v1` (`src/app/api/staff/v1/**`, `src/server/staff-api/**`, `src/app/staff-app/**`), its sign-in (`staff_app_tokens`) and phones (`staff_devices`). Separate from the customer `/api/v1`; the Rayz App builder (replacing Squire Commander) calls it | core |

Neither agent edits the other's files. If you need a change in the other side's file, put it under "Requests" below or in a PR comment.

## Rules both sides follow

- **Migrations are additive only.** Never rewrite, squash or renumber an existing migration. The core agent's new migrations are named `core_NNNN_<name>.sql` in `drizzle/` (the `_journal.json` tag matches the filename). The mobile agent uses its own prefix. Migrations up to `0019_slot_timing` already exist and stay as they are. The core side has since added `core_0020_stripe_connect`, `core_0021_service_times`, `core_0022_payroll`, `core_0023_staff_time`, `core_0024_block_reasons`, `core_0025_call_ins`, `core_0026_append_only`, `core_0027_locations`, `core_0028_digest_jobs`, `core_0029_location_banking`, `core_0030_time_clock`, `core_0031_clock_live`, `core_0032_clock_blocks`, `core_0033_tip_payouts`, `core_0034_staff_banking`, `core_0035_scrub_sensitive`, `core_0036_network_access`, `core_0037_handoff`, `core_0038_digital_receipts`, `core_0039_google_reviews`, `core_0040_review_visits`, `core_0041_marketing`, `core_0042_campaign_center`, `core_0043_lapsed_campaigns`, `core_0044_client_search`, `core_0045_openings`, `core_0046_morning_dashboard` and `core_0047_report_builder`.
- `drizzle/meta/_journal.json` and the snapshots are shared. When both sides add a migration, merge the journal by keeping both entries in `when` order, and regenerate the latest snapshot with `pnpm db:generate` (it should produce no new SQL).
- Server actions return `{ ok: true, data } | { ok: false, error }` through `safe()` in `src/server/action.ts`. Errors are `AppError(code, message, details)` from `src/server/errors.ts`.
- Every change to records goes through `audit(actor, action, entity, entityId, details, shopId, tx?)` in `src/server/audit.ts`.
- **Processor-hosted data only.** Card numbers, bank accounts, debit cards, SSNs, TINs, EINs, dates of birth for identity checks and ID documents are collected only by Stripe (Connect onboarding and the Express dashboards, the Payment Element, Terminal). Neither side adds a column, field, request or response property for them; store only Stripe's IDs, statuses, last 4 and bank or brand names. `src/lib/sensitive.ts` (`scrub`, `findSensitive`, `isForbiddenKey`) holds the rules, and `core_0035_scrub_sensitive` applies them in SQL. A new free-text column (a name ending in `note`, `notes`, `reason`, `body`, `subject`, `detail`, `details`, `errors`, `custom_fields` or `message`) needs a `<table>_scrub_sensitive` trigger calling `scrub_sensitive_row('<column>', ...)`, or `tests/db/sensitive-data.test.ts` fails.

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

### Per-location banking (core)

Each shop has a **payments mode** in `shops.payments_mode`: `connected` (the default; its own Express account and bank, for a separate LLC), `brand` (charges on the brand's own Stripe account, paid out to the brand bank) or `cash_only`. Pure rules are in `src/domain/connect.ts` (`PAYMENTS_MODES`, `takesCards`, `paymentsStep`, `statementDescriptorProblem`, `descriptorSuffix`, `receiptBranding`, `summarizePayout`).

- **Route every card charge through `chargeRoute(shop, amountCents, "keyed" | "terminal")`** in `src/server/payments/connect.ts`, then pass the result to `chargeCard`. It returns:
  - `{ settlement: "connected", destination, estimatedFeeCents }`: pass `destination` (a destination charge, as before).
  - `{ settlement: "platform", destination: null, estimatedFeeCents, descriptorSuffix }`: no destination, and pass `statementDescriptorSuffix: descriptorSuffix`. Store `processor_fee_cents` (Stripe's, or the estimate) and `settlement = 'platform'`.
  - For a cash-only shop it throws `AppError("payment_failed", …, { reason: "cash_only" })`. A shop on its own account that Stripe hasn't enabled still throws `reason: "payments_not_ready"`.
  - `chargeDestination` still works, but only knows about own accounts. Please use `chargeRoute` for app checkout and prepayment so brand-account and cash-only shops behave correctly.
- **Refunds** follow the original payment, not the shop's current mode: `reverse_transfer` when the payment has a `stripe_account_id`, a plain refund when it settled on the brand account. `refundSale` and the webhooks already do this.
- **Webhooks:** `/api/stripe/webhook` (platform) books dashboard refunds and disputes at the payment's shop, and records the brand account's own payouts. `/api/stripe/connect` handles `account.updated`, `capability.updated`, `account.external_account.*`, `account.application.deauthorized` and the connected accounts' `payout.*`.
- **Terminal:** `ensureTerminalLocation(shopId)` creates one Stripe Terminal Location per shop (`shops.stripe_terminal_location_id`). `registerReader(shopId, { label, registrationCode })` registers a reader to it. `assertReaderAt(shopId, readerId)` refuses a reader from another shop; checkout stores `payments.terminal_reader_id`.
- **Permission:** `payments.banking` is an owner grant (only the Brand Owner gives or removes it; Brand Admin's template doesn't have it). It covers choosing the mode, onboarding, the Express dashboard and the statement descriptor. `payments.accounts` still covers viewing status and refreshing it. Every change is audited (`payments.mode`, `payments.account_created`, `payments.onboarding_started`, `payments.dashboard_opened`, `payments.statement_descriptor`, `payments.terminal_location`, `reader.register`, `shop.receipt`).
- **We never store bank numbers, SSNs or EINs.** Stripe-hosted onboarding (Account Links) collects them. We keep the account ID, `charges_enabled`, `payouts_enabled`, `requirements_due` and the payout schedule Stripe reports. `tests/banking.test.ts` fails if a column like that appears.
- **Schema** (`drizzle/core_0029_location_banking.sql`):
  - `shops`: `payments_mode`, `statement_descriptor`, `receipt` (jsonb) and `stripe_terminal_location_id`.
  - `shop_payment_accounts.payout_schedule`.
  - `shop_payouts.shop_id` is now nullable: brand-account payouts are stored with `stripe_account_id = 'platform'` and no shop (a check enforces this). It also gains `gross_cents`, `fee_cents`, `refund_cents` and `item_count`.
  - `terminal_readers`: `device_type`, `stripe_location_id` and `registered_at`.
  - `payments`: `settlement` (`platform` or `connected`) and `terminal_reader_id`.
- **Env:** optional `STRIPE_STATEMENT_PREFIX` (default `RAYZ`) for brand-account shops' statements.

### Payroll (core)

Spec: [`docs/payroll-report-spec.md`](docs/payroll-report-spec.md). Workbook problems: [`docs/payroll-workbook-discrepancies.md`](docs/payroll-workbook-discrepancies.md).

- **No iSolved connection.** Output is a per-shop xlsx in the workbook's exact format, downloaded after approve-and-lock and uploaded by hand. Nothing calls iSolved. Exports go through `PayrollExporter` in `src/server/payroll/export.ts`.
- **Employee Numbers are sensitive.** `payroll_profiles.employee_number` lives in the database only. Please never return it from `/api/v1` or put it in logs, push payloads or fixtures.
- **Schema** (`drizzle/core_0022_payroll.sql`): `pay_groups` (one per shop, each with its own calendar and legal entity), `payroll_profiles`, `payroll_rates`, `time_entries`, `payroll_overrides`, `payroll_runs` (locked snapshots), `payroll_locked_ot`, and `brand_settings.payroll` (jsonb). New permissions `payroll.run` and `payroll.approve` (brand-only, added to Brand Admin).
- **Sales and tips** come from `payrollSalesBetween` in `src/server/reports.ts`, so a ticket counts at the shop it was rung up at, same as the reports.
- **Payroll reports** (`src/server/payroll/reports.ts`) read `buildPayroll` per pay period, so they tie to the file. `payroll_export_sends` (core_0106) records each period marked sent to iSolved; its status is draft, approved (locked) or sent. Admin only.
- Service times (`drizzle/core_0021_service_times.sql`): `appointment_times` records arrival, start, finish and checkout, each with who recorded it. The mobile side doesn't need to write it; check-in through the API can set arrival later if you'd like it.

### Staff time (core)

- **Code:** `src/domain/staff-time.ts` (pure: rules, limits, notice, recurring occurrences, time off spans, who's in) and `src/server/staff-time.ts` (blocks, series, requests, decisions, affected appointments, staffing). `extendSeries` is in `src/server/block-series.ts`, so the cron route doesn't import the staff app.
- **Schema** (`drizzle/core_0023_staff_time.sql`):
  - `time_blocks` gains `category` (lunch, break, personal, other, time_off), `series_id` and `request_id`. Existing `day_off` rows became `time_off`.
  - `time_block_series`: a weekday pattern written ahead into `time_blocks`.
  - `time_off_requests`: pending, approved, denied or cancelled, with who decided and how.
  - `brand_settings.staff_time` and `shops.staff_time` (jsonb rules).
  - New permissions `blocks.own`, `blocks.others`, `timeoff.request`, `timeoff.approve`, and the report `staffing`.
- **Reasons** (`drizzle/core_0024_block_reasons.sql`, `src/domain/block-reasons.ts`, `src/server/block-reasons.ts`):
  - `block_reasons`: the brand's list (`key`, `label`, `color`, `used_for` blocks/time_off/both, `counts_as_lunch`, `notice_exempt`, `private`, `sort_order`, `archived_at`).
  - `time_blocks`, `time_block_series` and `time_off_requests` gain `reason_id` and `note`. `reason` is now the label at the time (kept in step on a rename). `category` is just `lunch`, `other` or `time_off`; `break` and `personal` became reasons.
  - New permissions `blocks.private` (see private reasons and notes) and `blocks.reasons` (edit the list).
  - **Every read takes a viewer.** `staffingFor(shopIds, from, to, viewer, staffIds?)`, `timeOffEntries(shopIds, from, to, viewer, staffIds?)`, `listRequests(scope, { viewer, ... })` and `loadDayCalendar(..., reasons)` take a `ReasonViewer` (`reasonViewer(ctx)` in `src/server/auth/staff.ts`, or `NO_PRIVATE`). They return a `ShownReason` (`{ reasonId, label, color, note, hidden }`); a private one comes back as "Blocked" or "Time off" with no note. `RequestView.reason` is now a `ShownReason` and its separate `note` is gone.
  - **Customers never get a reason.** `/api/v1` availability only uses block times, as before. If the app ever shows staff blocks, please read them through these functions so the masking applies.
- **Availability:** `getAvailability` (and so `/api/v1` availability) now also leaves out **pending** time off for online and API bookings; staff bookings ignore it. Approved time off and every block were already left out. There's nothing to change on the mobile side.
- **Writes:** to add a block or time off, please go through `addBlock`, `requestTimeOff` and `decideTimeOff`, which now take a `reasonId` (and an optional `note`) instead of a category or reason key. They check booked appointments, write the audit rows and send the barber's email. Avoid inserting into `time_blocks` directly.
- **Notification kinds:** `time_off_reschedule` (to the client, with the manage link) and `time_off_decision` (an email to the barber).

### Call-ins and the shop line (core)

- **Code:** `src/domain/outreach.ts` (pure: rules, quiet hours, message wording, reply parsing, link states, follow-up timing) and `src/domain/twiml.ts`. Server: `src/server/call-ins.ts` (mark, affected appointments, reassign, outreach, text answers, follow-ups), `src/server/rebook-links.ts`, `src/server/messaging.ts` (opt-outs, inbox threads, call log), `src/server/shop-line.ts` (Twilio webhook handlers), `src/server/client-contact.ts` (staff text and click-to-call), `src/server/call-in-report.ts` and `src/server/twilio/*`.
- **Schema** (`drizzle/core_0025_call_ins.sql`):
  - `call_ins` (barber, shop or all, span, reason, note) with its own `time_blocks` row, so the calendar and availability treat it as time off.
  - `appointment_outreach` (one per affected appointment: option, status notified/delivered/rebooked/declined/no_response/flagged, attempts, next follow-up), `rebook_links` (SHA-256 of the token only, expiry, used and revoked).
  - `message_threads` and `messages` (the per-shop inbox), `call_logs` (in, out, missed, after hours, click-to-call), `contact_opt_outs` (phone and channel, with the customer ids STOP turned off).
  - New columns: `brand_settings.outreach` (jsonb rules), `customers.allow_other_shop`, `notification_jobs.provider_message_id`, `delivered_at` and `outreach_id`, and `shops.twilio_number` (unique).
  - A private **Emergency** time off reason.
  - New permissions `callins.mark`, `callins.mark_own`, `callins.outreach`, `callins.voice`, `inbox.view` and the report `call_ins`. There are 63 feature permissions now.
- **Notification kinds:** `callin_reassign`, `callin_rebook`, `callin_voice`, `callin_link` (the press-1 text), `missed_call` and `shop_reply`. `staff_call` (click-to-call) now really dials through Twilio, and `NOTIFICATIONS_VOICE_PROVIDER=twilio` is no longer a stub.
- **Opt-outs apply to every text.** `processDueJobs` now suppresses any SMS job to a number in `contact_opt_outs` (reminders included), and automated call-in calls to a number that pressed 9. If the app queues texts through `notification_jobs`, there's nothing to change.
- **Consent (mobile's area), touched lightly:** STOP sets `customers.sms_opt_in = false` for every client on that number and records which ones; START turns those same clients back on. Nothing else writes `sms_opt_in`. Please don't turn `sms_opt_in` back on for a number that's in `contact_opt_outs`, or the next text will be suppressed anyway.
- **Routes:** `/api/twilio/**` (signed Twilio webhooks) and the public rebook page `/r/[token]`. Nothing under `/api/v1` changed.
- **Availability:** a call-in is a time off block, so `/api/v1` availability already leaves the barber out.

### Time clock (core)

Everyone is paid hourly and punches in and out. This reverses the earlier "no clock-in" decision.

- **Code:**
  - `src/domain/time-clock.ts` (pure): pairing, breaks, the evidence check, schedule flags, the FT/PT rolling average, the export layout and DST wall times.
  - `src/server/time-clock.ts`: punches, the PIN, devices, edits, timesheets, approvals, locks, alerts and the cron pass.
  - `src/server/time-clock-export.ts`: the payroll CSVs and labor cost.
  - `src/server/labor-report.ts`: the Labor and Attendance reports.
  - `src/server/payroll/groups.ts`: pay groups and locks, split out of `payroll/run.ts` so the cron doesn't import the reports module.
- **Schema** (`drizzle/core_0030_time_clock.sql`):
  - `time_punches`: one row per punch (`in`, `break_start`, `break_end`, `out`). Each records its shop, `source` (self, kiosk or manager), `method` (device, gps, network, manager or none), lat/lng/accuracy and distance, IP, device, flags, minutes off the schedule, and void and edit stamps.
  - `time_punch_photos`, and `time_punch_edits`, which is append-only: a trigger refuses updates and deletes.
  - `clock_devices`: front-desk devices, holding only the SHA-256 of their token.
  - `timesheets`: per person, shop and period, with employee and manager approval.
  - `timesheet_locks` and `ft_status_changes`.
  - `shops` gains `latitude`, `longitude` and `time_clock` (jsonb: methods, radius, networks, grace, photo). `brand_settings` gains `time_clock` (jsonb rules). `staff` gains `clock_pin_hash` (bcrypt), `clock_pin_failures` and `clock_pin_locked_until`. `time_entries` gains `punch_in_id`.
- **Hours come from punches.** Each shift's paid time is re-derived into `time_entries` (source `clock`, linked by `punch_in_id`) on every punch or edit, so payroll, OT, tips and the Payroll Report need no change. Hand-entered hours still work.
- **If the app adds clock-in:** call `punch({ staffId, shopId, type, source: "self", evidence: { deviceShopId: null, ip, gps }, deviceId: null, photo, confirmTimeOff, actor })`, and `clockState(staffId)` for what to show.
  - `punch` returns `{ kind: "confirm", message }` during time off; ask the user, then call again with `confirmTimeOff: true`. Otherwise it returns `{ kind: "done", … }`.
  - A refused punch throws `AppError("bad_request")` with the reason, such as outside the geofence, not on the shop network or in a locked period. A shop that isn't theirs throws `forbidden`.
  - Please don't insert into `time_punches` directly.
  - Gate it on `timeclock.punch`. `punch` itself checks that the shop is one of theirs: a shop they're scheduled at, or one their access covers.
- **Permissions:** `timeclock.punch`, `timeclock.kiosk`, `timesheet.own`, `timesheet.edit`, `timesheet.approve`, `payroll.rates` and `payroll.export`, plus the reports `labor` and `attendance`. There are 74 feature permissions now.
- **Notification kinds:** `clock_forgot_out` and `ft_status_change`, both emails to the shop's managers.
- **Cron:** `/api/cron/notifications` now runs `timeClockCron`. It flags forgotten clock-outs and sends the live clock alerts on every run, and runs the FT/PT check once a night around 3 AM local. The response gains `timeClock`.
- **Employee Numbers** go into the CSV only, from `payroll_profiles`. The download's audit row holds the period, shops and row count, never the numbers. Nothing calls iSolved.
- **Clock events write real block-outs** (`drizzle/core_0032_clock_blocks.sql`, `src/domain/clock-blocks.ts`, `src/server/clock-blocks.ts`):
  - A break, a clock-out before the scheduled end and (when the shop turns on `notInBlock`) "Not in yet" become `time_blocks` rows. `time_blocks` gains `source` (`manual` or `clock`), `clock_key` (unique: `break:<punchId>`, `out:<punchId>`, `not_in:…`), `punch_id`, `end_punch_id`, `clock_open`, `overridden_at` and `overridden_by`. Please treat `source = 'clock'` rows as read-only from the app; they change through punches.
  - `time_punches` gains `reason_id` and `planned_min` (break start only). `punch()` takes optional `breakReasonId` and `plannedMin`.
  - `syncClockBlocks` runs inside every punch, edit, add and void. The cron (`refreshClockBlocks`) moves open blocks on to 15 minutes past now.
  - New table `clock_block_releases`: blocks a manager removed, so the clock doesn't write them back. New reasons `clocked_out` and `not_in` (`used_for = 'clock'`).
  - Because they're ordinary blocks, `getAvailability` and `loadDayInput` in `src/server/booking.ts` take the time out for online and `staffOverride` booking alike, on any date. `/api/v1` availability and booking pick this up with no change on your side.
  - The early time after an early clock-in is still read live (`src/domain/clock-live.ts`, `liveClock` in `src/server/clock-live.ts`), today only, for both.
  - The shop rules are keys in `shops.time_clock`: `blockOnBreak`, `breakHoldMinutes`, `blockAfterClockOut`, `notInBlock` (default false), `openEarly` and `lateAlertMinutes`. Their defaults are in `shopClockSettings`.
  - Audit actions: `block.create`, `block.update` and `block.delete` (as the person punching, or the manager editing the punch), and `block.clock_override`, `block.clock_release` and `block.clock_reset`.
  - `staff` gains `clock_opens_early` (boolean, default false): the barber's own permission for early time.
  - New table `clock_alert_log` (key, shop, sent at) sends each email once.
  - Clients never see clock status. The slots are simply absent, and the reason stays "No openings on this day". Please keep clock status out of `/api/v1` customer responses too.
  - New notification kinds `clock_late_in` and `clock_affected`: emails to the shop's managers with `calendar.manage`. The cron's `timeClock` result gains `clockAlerts`.

### Tip payouts (core)

- **Code:** `src/domain/tips.ts` (pure: policy and shop settings, availability, statuses, batch drafting, fee share, instant fee), `src/server/tips/ledger.ts` (ledger sync, settings, reading), `src/server/tips/payouts.ts` (batches, holds, adjustments, cash, Stripe, webhooks, payroll, cron), `src/server/tips/accounts.ts` (employees' Express accounts: status, destination, notices), `src/domain/banking.ts` (pure: the four banking statuses, requirement labels, destinations) and `src/server/tips/report.ts`.
- **Schema** (`drizzle/core_0033_tip_payouts.sql`):
  - `tip_ledger`: one row per tip (`payment_id`, unique), per refund or void that gave tip back (`refund_id`, unique, negative), or per manager adjustment (with `reason`). Each has its shop, staff, sale, method, amount, fee share, business date and `payout_id`. A trigger refuses changes to amounts, people, dates and kind, moving an entry to another payout, and taking it off a payout that's approved, processing or paid.
  - `tip_payout_batches` (kinds `end_of_night`, `daily_delay`, `weekly`, `manual`, `payroll`, `opening`; one draft per shop) and `tip_payouts` (one per batch and employee; method `cash`, `stripe`, `payroll` or `prior`; Stripe debit, transfer and payout ids, each unique; cash `drawer_date` and acknowledgment; hold reason).
  - `staff_payout_accounts`: the employee's chosen method, instant flag and Express account id with its status. `core_0034_staff_banking` adds what Stripe returns about the payout destination (`destination_type` `bank_account` or `card`, `destination_last4`, checked to be 4 digits, and `destination_name`, the bank or card brand), `requirements_pending` and `requirements_deadline`. No full account, routing or card number, SSN or ID is ever stored.
  - `brand_settings.tip_payouts` and `shops.tip_payouts` (jsonb), and `cash_drawers.tip_payouts_cents`.
  - The migration fills the ledger from existing payments and refunds and records it all as paid before tip payouts (`prior` payouts in an `opening` batch per shop).
- **If the app checks out or refunds**, nothing extra is needed: `syncTipLedger` runs inside checkout and refunds, and before every batch, from `payments.tip_cents` and `refunds.tip_cents`. Please don't insert into `tip_ledger` or `tip_payouts` directly.
- **If the app shows an employee's tips** later, read `myTips(staffId, shopIds)` from `src/server/tips/ledger.ts` and gate it on `tips.own`. Please never return other people's tips, or Stripe account ids, from `/api/v1`.
- **If the app shows an employee's banking** later, use `staffAccountState` (one of `not_set_up`, `pending_verification`, `ready`, `action_needed`) and `accountDestination` from `src/server/tips/accounts.ts`, and send them to `/admin/my-banking` (or Stripe's hosted pages through `staffOnboardingUrl` and `staffDashboardUrl`) to change anything. For anyone else, use only `payoutAccountSummaries` (method, status, last 4). Please change accounts only through `setPayoutChoice` and the functions there, which audit and send the security notices.
- **Stripe:** each barber has one recipient connected account (ST-I9, `core_0108`): no Stripe dashboard (`controller.stripe_dashboard.type = none`, the brand setting `staff_payouts.dashboard`), the `transfers` capability, the `recipient` service agreement, the platform paying fees and losses. Onboarding is embedded in the staff app (an Account Session, `POST /api/staff/v1/banking/account-session`) with an Account Link as the fallback, returning to the HTTPS pages `/staff-app/stripe/return` and `/refresh`. Their events come to the Connect webhook (`/api/stripe/connect`), which hands them to `handleStaffConnectEvent` in `src/server/tips/connect-events.ts`: `account.updated`, `capability.updated`, `account.application.deauthorized`, `account.external_account.*` and `payout.*`. The platform webhook handles `transfer.reversed`, and `charge.dispute.created` records the shop absorbing the tip.
- **Account states (ST-C12):** `staff_payout_accounts.state` is one of `not_started`, `in_progress`, `pending_verification`, `requirements_due`, `restricted`, `active` or `rejected` (`accountState` in `src/domain/staff-payouts.ts`), audited in `tips.account_state` as `state: { from, to }` (with `unexpected: true` for a move the machine doesn't expect). Only `active` and `requirements_due` can be paid. `staffAccountState` still returns the four banking statuses.
- **Money movement:** `src/server/payments/money-movement.ts` is an interface, `MoneyMovement { name, send(transfer, save), unwind(...) }`, with nothing registered: there's no transfer path until ST-C11. `payOutToConnectedAccount` and `unwindPayOut` are gone. With no path, an approved Stripe payout is held as `hold_kind = 'transfers_pending'` (owed). Where `staff_payouts.owedVia` is `payroll` (the default), approve-and-lock moves owed tips (unclaimed, or in a payout held for setup or a transfer path) into the period's payroll payout, once (ST-C14).
- **Test mode only.** `moneyClient()` refuses live keys (anything but `sk_test_` or `rk_test_`) for employee accounts, onboarding, transfers and payouts until `MONEY_MOVEMENT_LIVE=true` (off by default), and approving a batch with Stripe payouts is refused while it's off.
- **Instant payout fee** (`brand_settings.tip_payouts.instantFeePassedOn`, default true): passed on, the employee receives net − fee and the shop's debit is the net; absorbed, the employee receives the whole net and the shop's debit is net + fee. Either way the platform keeps the fee, since Stripe charges the platform for Express accounts' instant payouts (`fees.payer = application`). `tip_payouts.instant_fee_paid_by` (`employee` or `shop`) is fixed when the payout is built. Use `receivedCents`, `shopCostCents` and `employeeFeeCents` from `src/domain/tips.ts`, never `net − instant fee`.
- **External accounts:** `staff_payout_accounts.external_accounts` (`core_0100`) lists every bank account and card on the Express account as `{ id, type, name, last4, default, instant }`: Stripe's `ba_`/`card_` id, never a number. It's kept in step by `account.updated`, `account.external_account.*` and refreshes. `externalAccountsView` in `src/server/tips/accounts.ts` reads it; `tip_payouts.destination_type` and `destination_last4` record where each payout went.
- **Payroll:** `payrollTipSplit` gives each line `tipsInPayroll`, `tipsOutside` (still `E_Cash Tips Recd_Dollars`) and `tipsPaidOut`. The iSolved file gets an extra column (`tipsInPayrollHeader`, default `E_Tips Paid In Payroll_Dollars`) only when someone has tips paid in payroll. Paid tips are marked too: with `markPaidTips` (default on), tips already paid out in cash or by Stripe when the period is locked go in a memo column (`tipsPaidOutHeader`, default `M_Tips Paid Out_Dollars`, the code to confirm with Charles), only when someone in the file has them. It's part of `E_Cash Tips Recd`, never paid again, and the reconciliation gate checks its total. `lockPayrollTips` runs inside approve-and-lock.
- **Permissions:** `tips.own`, `tips.approve` and `tips.settings` (brand-only), `payouts.view`, `payouts.manage` and `payouts.chain` (the payout tracker, `/admin/tips/tracker`), and the reports `tip_payouts` and `payroll_tips_paid`.
- **Ledger (ST-C13 to C15, ST-I14):** every `tip_ledger` entry has `employer_id` (`payroll_employers`, one per pay group legal entity, with the iSolved company code and only the last 4 of the EIN), set by a trigger and never changed. Tips are dated by `staff_payouts.tipDate` (the sale date by default). A refund reverses the tip only by `staff_payouts.reversalRule` (default: a full refund within `reversalWindowDays`, 7); anything else is a `tip_absorptions` row the shop pays, as is every dispute. Never both. The report Tips paid (iSolved) and its CSV go per pay period, employer and employee, final only when earned = paid via Stripe + cash + through payroll + owed.
- **Notification kinds:** `tip_payout`, to the employee (email, or a text if they have no email) when a payout is sent or fails, and to the shop's email when one fails. `tip_banking`, to the employee: Stripe needs more information (email, or a text without one), and security notices when the payout destination or method changes (email and text).
- **Cron:** `/api/cron/notifications` runs `tipPayoutCron`, which builds each live shop's daily or weekly draft once it's due. The response gains `tipPayouts`.
- **Everyone re-registers (Charles, 2026-10-27).** No Squire staff Stripe account is migrated: every employee does fresh Express onboarding under Ray'z.
  - **Pending, never lost:** a Stripe payout for someone Stripe can't pay yet is built `held` with `tip_payouts.hold_kind = 'stripe_setup'` (`core_0101`; a manager's hold is `'manager'`). It's never switched to cash. One approved before their account stopped being payable goes back to held instead of failing. Its tips stay claimed by it. Once `canReceive` turns true (`account.updated` or the simulator), `releaseSetupHolds` puts it back: pending in a draft batch, or sent in an approved one. A manager can't release it by hand; taking it out of the batch returns its tips to the next batch. Read waiting amounts with `waitingForSetup(staffIds)` or `myTips(...).waitingForSetup`.
  - **Tracker and invites** (`src/server/tips/onboarding.ts`, `/admin/tips/onboarding`, `tips.approve`): progress `not_invited`, `invited`, `started`, `blocked`, `verifying` or `done` (`src/domain/staff-onboarding.ts`), and bulk invites by text, email or both, recorded in `staff_onboarding_invites`. Reminders come from the notifications cron (its response gains `payoutSetupReminders`), 9 AM to 7 PM. The default is every 3 days, up to 4 times; the brand sets this in `brand_settings.tip_payouts.reminderEveryDays` and `reminderMax`. Reminders stop when the person is done or leaves. Links point to `/staff-app/payouts`, which opens `${STAFF_APP_SCHEME:-rayzstaff}://banking` or `/admin/my-banking`.
  - **Notification kind `tip_onboarding`:** the invite or reminder, sent by email or text. No account details are in it.
  - **Cutover:** `shop_cutovers.squire_tips_end_on` is the last day Squire pays the shop's tips. `signOffAndSwitch` refuses until everyone active at the shop is `done`, unless an owner gives a reason. The `cutover.switch` audit records `staffPayouts`.

### Sign-in restrictions (core)

- **Code:** `src/domain/network-access.ts` (pure: rules, IP and CIDR checks, the verdict, `BLOCK_MESSAGE`), `src/lib/client-ip.ts` (`clientIp(headers)`, the only reader of `x-real-ip`, `x-vercel-forwarded-for` and `x-forwarded-for`; a test fails if any other file in `src` names `x-forwarded-for` or `x-real-ip`), `src/server/auth/network.ts` (devices, `evaluateNetwork`, `recordBlocked`, `gateRequest`) and `src/server/sign-in-security.ts` (settings, devices, the portal's lists).
- **Schema** (`drizzle/core_0036_network_access.sql`): `shops.network_access` (`{enabled, require: ip|device|either|both, allowedIps}`) and `brand_settings.network_access` (`{alertOnBlock}`), both jsonb defaulting to `{}`, meaning off. `trusted_devices`: one row per browser and shop, with only the SHA-256 of the cookie's secret (`token_hash`), status `pending|approved|declined|revoked`, who asked, who decided, and last seen.
- **Enforcement:** `src/middleware.ts` now runs on the Node runtime and calls `gateRequest` for every `/admin` request with a session cookie. `getStaffContext` calls `evaluateNetwork` and drops the shops a request can't reach (`withoutShops` in `src/server/auth/access.ts`), returning null when none are left. Staff sign-in checks after the password. Exempt: the Brand Owner, and `access.remote` at the shop.
- **Permissions:** `access.remote` and `devices.approve` (Staff group) and `network.settings` (brand-only). The migration gives Brand Admin all three and Regional and Shop Managers `devices.approve`. There are 80 feature permissions now.
- **Audit actions:** `network.blocked` and `network.limited` (entity `staff`, one per shop, details `ip`, `via`, `shop`, `missing`, `require`, `path`, `device`, `userAgent`), `network.rule` (entity `shop`), `network.settings` (entity `brand_settings`, the alert), and `device.request`, `device.approve`, `device.decline`, `device.revoke`, `device.trust`. Notification kind `access_alert` (email).
- **If the app ever adds staff endpoints** to `/api/v1`, please call `evaluateNetwork(access, { ip: clientIp(req.headers), deviceShopIds })` and refuse or narrow the same way, with `BLOCK_MESSAGE`. Customer endpoints aren't affected and nothing in `/api/v1` changed.

### Customer screen at checkout (core)

- **Code:** `src/domain/handoff.ts` (pure: tip buttons and their amounts, settings schemas, steps, the credit total `amountsFor`, `splitCents`, `tipWeights`, `splitBarbers`), `src/server/handoff.ts` (settings, start, the view, tip, signature, receipt, reader, pay, cash, unlock, end, resume, the receipt record), `src/server/auth/handoff-lock.ts` (the `rayz_handoff` JWT, `typ: "handoff"`, 12 hours; `lockedHandoff` checks the row on every request) and `src/app/handoff/[id]/**` (the customer screen and its actions).
- **Schema** (`drizzle/core_0037_handoff.sql`):
  - `brand_settings.handoff` (`{tips}`) and `shops.handoff` (`{tips | null, tipEntry: screen|reader, signature, unlock: staff|manager, afterPayment: auto|pin, thankYouSeconds}`), jsonb defaulting to `{}`. Shops whose `tip_presets` weren't the default got them as their own buttons. `shops.tip_presets` is still written (the shop's percent buttons) and is what the counter uses.
  - `checkout_handoffs`: one row per hand-off, with the ticket as handed over (`draft`), the tip and where it came from, the signature (SVG path), the receipt choice (the typed number or email is cleared once paid; `receipt_masked` stays), and `status` `active|paid|returned`. One active per sale.
  - `sale_tip_shares` (`sale_id`, `staff_id`, `weight`): only on tickets whose tip is split. The views `tip_split_shares` (each barber's whole cents of every tip and tip refund on those tickets) and `tip_split_moves` (the shares, less the whole tip from the ticket's barber; zero per tip).
  - `tip_ledger_payment_uq` and `tip_ledger_refund_uq` are now `(payment_id, staff_id)` and `(refund_id, staff_id)`, since a split tip is one entry per barber.
- **Checkout:** `finalizeSale` takes an optional `tipSplit` (`services` or `evenly`) and each line's optional `staffId`. It refuses while the ticket is with the client (`conflict`, "with the client").
- **Lock:** `src/middleware.ts` now matches every page except `_next`, `api` and files (`/((?!_next/|api/|.*\..*).*)`), not just `/admin`. With a live `rayz_handoff` cookie, pages redirect to `/handoff/{id}` and actions get 403. `getStaffContext` returns null while it's live, so `/api/*` staff routes using `routeStaff()` refuse too. `/api/v1` is untouched.
- **Permissions:** `handoff.unlock` (Point of sale group; Brand Admin, Regional and Shop Manager) and `handoff.settings` (brand-only; Brand Admin). There are 82 feature permissions now.
- **Audit actions:** `handoff.start`, `handoff.paid`, `handoff.unlock` (the PIN's person, with the rule), `handoff.end` (from the counter), `handoff.settings` (shop) and `handoff.brand_settings`.
- **Reports:** every query that credits tips to the ticket's barber adds `tip_split_moves`, so per-barber tips are split and shop totals are unchanged. `payrollSalesBetween` does the same. If the app ever shows a barber's tips, please read through these functions rather than `sales.tip_cents`.
- **If the app checks out a ticket with several barbers** later, please pass `staffId` per line and `tipSplit`, and leave the split to `finalizeSale`. Please don't write `sale_tip_shares` directly.

### Digital receipts (core)

- **Code:** `src/domain/receipts.ts` (pure: `receiptConsent`, `cardLabel`, `tenderLabel`, `barberFirstName`, the text and email wording, `REQUEST_LIMIT`), `src/server/receipts.ts` (`receiptData`, `deliverReceipt`, `sendUpdatedReceipt`, `sendReceiptFromStaff`, `requestReceiptCopies`, `resolveReceipt`, `stopReceiptEmails`, `saleReceiptState`, `isOptedOut`), `src/app/receipt/**` (the page and the copy request) and `src/app/admin/sales/[id]/receipt-panel.tsx`.
- **Schema** (`drizzle/core_0038_digital_receipts.sql`):
  - `receipt_deliveries`: one row per receipt sent or chosen. `sale_id`, `shop_id`, `customer_id`, `channel` (`sms|email|none`), `destination` (null exactly when `none`), `masked`, `purpose` (`counter|handoff|refund|void|resend|request`), `token_hash` (SHA-256 of the link's token, unique), `job_id` (the `notification_jobs` row, kind `receipt`), `skipped` (`opted_out|no_consent`, when an update wasn't sent), `sent_by`.
  - `receipt_opt_outs` (`email` primary key): emails that used **Stop receipt and review emails** on a receipt. Receipts and review requests only; it isn't marketing consent.
  - `ReceiptBranding` (in `shops`' receipt settings) gains `reviewUrl` (`https://` or null) and `allowPrint` (default false).
- **Consent:** a number in `contact_opt_outs` (sms) or an email in `receipt_opt_outs` is never sent a receipt. Choosing a receipt at checkout or asking for copies is consent for that receipt. Updates (refund, void) and resends to what's on file need the client to have chosen that destination for the ticket, or `sms_opt_in`/`email_opt_in`; a destination staff type in counts as the client asking. Core reads these columns and doesn't write them.
- **Hand-off:** the receipt step and `payHandoff` now go through `deliverReceipt` (purpose `handoff`) in a savepoint, so a receipt failure never undoes the payment. An opted-out number on file isn't offered.
- **Refunds and voids:** `reverse()` and `recordProcessorRefund` call `sendUpdatedReceipt` (never throws, savepoint), and their audit details carry `receipt: {status, to}`.
- **Audit actions:** `receipt.sent`, `receipt.none`, `receipt.resent`, `receipt.requested`, `receipt.email_opt_out` (destination masked).
- **If the app shows receipts**, please send them through `deliverReceipt` (purpose `request` or `resend`) or `requestReceiptCopies(contact)` and use the `/receipt/{token}` page, rather than building a receipt of your own. Only the token's hash is stored, so a link can't be rebuilt from a row later. Please also treat `receipt_opt_outs` as "no receipt emails" for that address.

### Google reviews (core)

- **Code:** `src/domain/reviews.ts` (pure: `googleReviewLink` parses a `g.page/r/…` link, a `search.google.com/local/writereview?placeid=…` link or a bare Place ID into the saved `https` link; `reviewFollowUp` settings; the text and email wording; `isAutomatedOpen`), `src/server/reviews.ts` (`openReviewLink`, `askForReview`, `queueReviewFollowUps`), `src/server/review-rules.ts` (`loadReviewRules`, `saveReviewRules`, `visitNumber`, `reviewTiming`), `src/server/review-report.ts`, `src/app/receipt/[token]/review/route.ts` and `src/app/admin/settings/review-fields.tsx` (settings and wizard).
- **Schema** (`drizzle/core_0039_google_reviews.sql`):
  - `receipt_deliveries.purpose` gains `review` (the follow-up; `notification_jobs.kind` `review_request`), and `skipped` gains `recent` (asked at this location within the repeat days). New index on `(customer_id, shop_id, purpose, created_at)`.
  - `review_clicks`: `shop_id`, `staff_id` (the ticket's barber), `sale_id`, `delivery_id` (the link used), `source` (`receipt|follow_up`), `created_at`. No free-text columns.
  - `ReceiptBranding.reviewUrl` is now Google only (anything else reads as null), and `reviewFollowUp: { enabled, delayHours (1–48), repeatDays (0–365) }`, off by default.
  - Report permissions `report.google_reviews.view`/`.export` for Brand Admin, Regional Manager and Shop Manager.
- **When it's shown** (`drizzle/core_0040_review_visits.sql`): `brand_settings.reviews` `{ minVisits (1–50, default 3), snoozeDays (0–365, default 90) }`; per location `ReceiptBranding.reviewMinVisits` / `reviewSnoozeDays` (null: the brand's). The receipt's `reviewUrl` is null before the client's Nth visit (distinct shop and local day across all locations: `completed` appointments and `paid|partially_refunded|refunded` sales, imported included, up to the ticket's day) and for `snoozeDays` after a `review_clicks` row from another of their tickets at that location. Follow-ups held for those reasons are skipped `few_visits` or `snoozed` (added to the check). Brand changes are audited as `brand.review_rules`.
- **Consent:** the follow-up goes only to `sms_opt_in` (text, first) or `email_opt_in` (email) clients, never to a number in `contact_opt_outs` or an email in `receipt_opt_outs`, and not in quiet hours (`brand_settings.outreach`). A receipt choice isn't consent for it. Core reads these and doesn't write them.
- **No gating:** who's asked depends only on the visit count, a recent tap and consent, never on ratings, tips, refunds or complaints, and the button looks the same for everyone who gets it. Please keep it that way if the app asks for reviews (Google policy).
- **Cron:** `/api/cron/notifications` runs `queueReviewFollowUps()` before sending due jobs.
- **If the app shows a Leave a review link**, please link to `/receipt/{token}/review` (or use `receiptData(saleId).reviewUrl`, which applies the visit and pause rules; `reviewTiming(saleId)` says why it's held) so clicks are counted, and don't add a rating step in front of it.

### Campaign Center (core)

Called "Marketing / Engage" at first. The UI, routes, permissions and report now say Campaign Center; the code paths, tables and notification kind keep `marketing`.

- **Code:**
  - Pure: `src/domain/coupons.ts` (`couponDiscount`, `couponProblem`, `stackProblem`, `couponSummary`, `uniqueCode`, `issuedExpiry`) and `src/domain/marketing.ts` (`TRIGGERS`, `render`/`fill`, `templatesProblem`, `inQuiet`, `nextSendAt`, `capProblem`, `pickChannel`, `SegmentSchema`, `dedupeKey`, `roi`).
  - Server: `src/server/coupons.ts`, `src/server/booking-drafts.ts`, and `src/server/marketing/` (`consent`, `audiences`, `engine`, `campaigns`, `sequences`, `my-clients`, `links`, `report`, `lapsed-report`, `settings`).
  - Routes: `/admin/campaign-center` (campaigns, blasts, `sequences/{id}`, `my-clients`, settings, `/export`), `/admin/reports/campaign-center`, `/admin/reports/lapsed-clients`, `/api/cron/campaign-center`, and `/m/{token}` and `/m/{token}/unsubscribe` (unchanged, since they're in messages already sent).
  - Shared report helpers moved out of `reports.ts` into `report-sql.ts` and `available-minutes.ts`; `reports.ts` re-exports them.
- **Schema** (`drizzle/core_0041_marketing.sql`):
  - `promo_codes` gains `free_item_kind`/`free_item_id` (type `free_item`), `service_ids`, `product_ids`, `shop_ids` (jsonb, empty means all), `min_spend_cents`, `max_per_customer`, `code_mode` (`shared|unique`), `valid_days`, `first_visit_only`, `stackable` (default true) and `auto_apply`. Existing codes are unchanged shared codes.
  - `coupon_codes`: single-use codes issued to one client by a campaign (`expires_on`, `redeemed_at`, `sale_id`).
  - `coupon_redemptions`: one per sale and coupon, `via` `code|booking|auto`, with `campaign_id` and `reversed_at` (refund or void).
  - `appointment_coupons`: the code held from online booking.
  - `marketing_campaigns`: `kind` `trigger|blast`, one row per trigger key. Blasts have `segment`, `shop_ids`, and `status` `draft|scheduled|sending|sent|cancelled`.
  - `marketing_location_settings`: per campaign and shop, `enabled`, and `templates`/`settings` overrides.
  - `marketing_sends`: one per client per campaign occasion. `dedupe_key` is unique; `status` is `queued|skipped|test`; also `job_id` (`notification_jobs` kind `marketing`), a 22-character `token`, `book_path`, `clicks` and `cost_cents`.
  - `marketing_unsubscribes`: by channel and client, email or phone; `source` is `link|stop|staff`.
  - `booking_drafts`: unfinished online bookings by a browser token.
  - `customer_tags`.
  - `brand_settings.marketing`: quiet hours, caps, postal address, HELP text, attribution days and costs.
  - Permissions, renamed by `drizzle/core_0042_campaign_center.sql` in `roles.permissions` and `staff.permission_overrides`: `campaign_center.view`, `.create`, `.send` and `.export` (labels "Campaign Center: view/create/send/export"), and `report.campaign_center.view`/`.export`. The old `marketing.location` and `marketing.manage` each became create plus send; `marketing.*` keys no longer exist.
  - Lapsed sequences (`drizzle/core_0043_lapsed_campaigns.sql`): `marketing_campaigns.kind` gains `sequence` (its audience in `segment` as `{ staffIds, barberMatch }`, `settings.stopAfterDays`) and an `enabled` column; `marketing_steps` (`campaign_id`, `position`, `after_days` 7–365, `templates`, `promo_id`); `marketing_sends.step_id`. Occasions are `seq:{last visit day}:{step id}` for sequences and `barber:{last visit day}` for From your barber (trigger key `barber_outreach`, sent by hand, never by the cron).
  - Also added by core_0043: `campaign_center.own_clients` ("Campaign Center: own lapsed clients") for Brand Admin, Regional Manager and Shop Manager roles that have `campaign_center.view`, and `report.lapsed_clients.view`/`.export` for those with `report.campaign_center.view`. The Barber template doesn't have it.
  - We have openings (`drizzle/core_0045_openings.sql`): `marketing_campaigns.kind` gains `openings` (one row per barber per send; `segment` is `{ staffId, dates, lastVisitOverWeeks, serviceId }`, `settings.openSlots`), statuses `pending_approval|rejected|expired`, and `reviewed_by`, `reviewed_at`, `review_note`; table `openings_waitlist`; `brand_settings.marketing.openings` for the cap, limits, approval and wording. Permission `campaign_center.openings` and report `report.openings`. The same migration takes `promos.manage`, `campaign_center.view/create/send/own_clients` and the Campaign Center and lapsed reports out of the Regional and Shop Manager roles: the brand grants them back.
- **Consent (read-only for core):**
  - Marketing reach per channel reads the columns below. `consentColumns()` checks which exist once a minute; until they do, nobody qualifies.
    - `customers.sms_marketing_opt_in`
    - `customers.email_marketing_opt_in`
    - `customers.push_marketing`
    - `customer_devices` (`push_enabled`, `revoked_at`, newest `last_seen_at`)
    - `customers.deleted_at`, if present
  - `contact_opt_outs` (sms) and `marketing_unsubscribes` always win. `sms_opt_in`/`email_opt_in` (appointment messages) are never read as marketing consent.
  - Core writes only `marketing_unsubscribes`, from its own links, STOP and START.
- **STOP, START and HELP** on the shop line:
  - STOP also adds an `sms` unsubscribe and cancels pending marketing jobs. START removes the STOP unsubscribes.
  - HELP gets the brand's HELP text unless `TWILIO_ADVANCED_OPT_OUT=1`.
- **Audit actions:**
  - Campaigns: `campaign_center.automation_saved`, `campaign_center.automation_on`/`_off`, `campaign_center.test_sent`.
  - Blasts: `campaign_center.blast_created`, `_saved`, `_scheduled`, `_sent`, `_cancelled`.
  - Sequences: `campaign_center.sequence_created`, `_saved`, `_on`, `_off`, `_deleted`; a barber's send: `campaign_center.own_clients_sent`.
  - Other: `campaign_center.export`, `brand.campaign_center_settings`, `promo.create`/`.update`, `customer.tags`. Rows written before the rename keep their `marketing.*` and `brand.marketing_rules` names.
- **If the app takes coupons or bookings:**
  - **Bookings:** check and hold a code with `checkBookingCoupon(shopSlug, code)` and `holdBookingCoupon(appointmentCode, code)` right after booking, so the POS picks it up.
  - **Checkout:** redeem only through checkout's `redeemCoupons` (it re-checks limits under a lock), and never increment `promo_codes.redemptions` yourself.
  - **Unfinished bookings:** `saveBookingDraft` and `finishBookingDraft` feed the "Finish your booking" campaign.
- **Push:**
  - Marketing push jobs have `channel = 'push'` and `to` set to the `customer_devices.id`.
  - The provider (`NOTIFICATIONS_PUSH_PROVIDER`) is `disabled`, `console`, `simulator` or an `expo` stub.

### Brand-to-shop settings ("brand-sync registry")

`src/server/brand-sync` is the registry. Every brand-level option and permission is a sync type there (`SYNC_TYPES` in `src/domain/brand-sync.ts`), and the brand sends a change to the shops it picks:

- **Settings registry** (`settings.ts`, type `setting`): one entry per brand setting in `brand_settings`. A shop's own value is in `shop_sync_state.local` under `setting:<key>`; read it with `settingAt(key, shopId)` or `brandColumn(column, shopId)`, never `brand_settings` directly.
- **Shop settings registry** (`shop-settings.ts`, type `shop_setting`): settings each shop keeps in its own `shops` column (online booking, selling with no stock, phone operator, customer screen, tip payout schedule). The brand's value is in `brand_sync_values` under `shop_setting:<key>`.
- **Roles** (type `role`): every role but the Brand Owner; a shop's own version of a role lives in `shop_sync_state.local`.
- **Brand lists** (`lists.ts`, type `list`), catalog (`service`, `product`, `service_rule`), money (`card_fee`, `taxes`, `tips`), location (`location_default`, `hours`, `receipt`, `closure`), rules (`field_rule`, `prompt_rule`), marketing (`campaign_template`, `automation`) and the feature switches (`app`, `checkout_prompts`, `milestones`, `loyalty`).
- **Booking times:**
  - Interval precedence is in `resolveInterval` in `src/domain/timing.ts`: barber at shop, then barber, then shop, then brand (the `slot_interval` setting at that shop).
  - Duration precedence is in `resolveDuration`: barber at shop, then barber, then the shop menu, then the service default.

`tests/db/brand-sync-coverage.test.ts` fails when a table, column, brand value, permission or role isn't registered.

### Schema notes the mobile side may read

- `appointments`:
  - `busy_from` and `busy_until` are set by a trigger from `buffer_before_minutes` and `buffer_minutes`.
  - The `appointments_no_double_booking` constraint stops service times overlapping. `appointments_no_buffer_overlap` stops buffers overlapping, unless the booking has `squeezed = true`.
  - Online and API bookings must start on a time from `getAvailability`, which is per barber now (`slot.ends[staffId]`). Squeeze-in is staff-only.
- `payments` gains Connect columns. See the I10 section above, and `settlement` and `terminal_reader_id` in the per-location banking section.
- `shop_payouts.shop_id` can be null (brand-account payouts). Join with a left join.

### Client notes (brand-wide)

Notes follow the client to every location. Domain (pure): `src/domain/client-notes.ts`. Server: `src/server/client-notes.ts`, with staff route handlers in `src/server/client-notes-api.ts`.

- **Kinds:** `profile` (can be pinned; pinned notes show on the appointment block, check-in and checkout), `visit` (cut and formula notes: `details` holds `guard`, `style` and `products`, with up to 4 before/after photos, optionally tied to an appointment) and `private` (managers only).
- **Who sees them:** anyone with `notes.view` who reaches the client (a client they may look up, or one booked at their shop from yesterday on, in their own column unless they run the calendar), as far as Client data protection's "Client notes" level allows: full shows them, masked shows only the count, hidden shows nothing. `private` needs `notes.private`, which a shop login never has. Writing needs `notes.write`; anyone's notes at their shops need `notes.edit_any`.
- **The record note:** `customers.notes` stays the client's main profile note. A trigger keeps it as a pinned `profile` note with `source = 'record'`, so every existing writer (the importer, `/api/v1`, the profile) still works and still follows the field's add and edit rules.
- **Contact details never stay in a note.** `redact_contact_text` (SQL) and `redactContact` (TypeScript, same patterns) replace emails and phone numbers with `[email removed]` and `[phone removed]` in `client_notes.body` and `details` and in `customers.notes`, whoever writes them. The app warns while typing and reports `removed` after saving.
- **Squire:** a clients file's Notes become the record note (credited "Squire"); an appointments file's notes become that visit's cut note, dated the visit (`source = 'squire_visit'`, idempotent on re-import). Both come from triggers, so `importer.ts` is unchanged.
- **Migration `core_0057_client_notes`:** the `client_notes` and `client_note_photos` tables, the redaction and sync triggers, a backfill, and the four permissions.

### Company-wide clients (core)

A client profile is the brand's, never a shop's: one record across every location, with visits, notes, badges, family, loyalty, gift cards, ratings, consent and cadence adding up across shops. `customers.home_shop_id` and the shops visited are reporting attributes only.

- **Lookup:** `searchClients` / `findClients` in `src/server/client-search.ts` reach every client from any shop by any part the searcher may search (the client policy still decides what each hit shows). Only `ownClientsOf` (a barber's own list) narrows it, and ticket and appointment numbers still find only the searcher's shops' tickets. `searchCustomers(term, limit, reach)` in `customers.ts` lost its shop `scope` argument; `SearchScope`, `clientSearchScope`, `scopedSearchWhere` and `customerExactWhere` are gone.
- **Shop logins and money:** a shop login (`staff.kind = 'shop'`) sees a client's visits at every shop (date, shop, barber, services) but prices, tickets and spend only for its own shop. On the web profile that's `customerStats(id, db, now, ctx.shopIds)` and the sales list filtered with `inShops`.
- **Squire:** `reconcileSquireClients(csv, { dryRun, actor })` in `src/server/squire-reconcile.ts` runs after a clients import (the admin action and the CLI). It fills empty birthdays from the file's Birthday column, merges same name + birthday pairs where no phone or email disagrees (`mergeDuplicatePairs`), and leaves the rest on the duplicates page's Squire tab. `importer.ts` is unchanged.
- **Merges:** `mergeCustomers` now keeps one `client_badges` row (marked stale) and drops duplicate `client_badge_notices`, so two records with cached badges merge.

### Compensation fields (core)

Optional and off until the brand turns it on (`brand_settings.compensation.enabled`). Domain (pure): `src/domain/compensation.ts`. Server: `src/server/compensation.ts`; the report is `src/server/commission-report.ts`.

- **Schema (`core_0058_compensation`):** `staff_compensation` (one row per version: `effective_from`, rates in cents and fractions, overrides, tiers, booth rent, guarantee, tip method and card-fee netting, a note). Rows are append-only: a trigger refuses updates, refuses deleting a version that has started, and refuses a version starting on or before the last locked `payroll_runs.period_end`. Also `staff_custom_fields`, `staff_custom_values` and `brand_settings.compensation`. A check refuses field names for bank, card, SSN, tax ID, licence, passport or birth date data. No bank or SSN data anywhere: that stays with Stripe and iSolved.
- **Reading a plan:** `versionsFor(staffIds)` returns each person's versions, newest first, and `versionOn(sorted, date)` gives the one in effect. A blank part of a plan means Payroll setup's rate, or the shop's tip setting. `commissionLines` plus `commissionBetween` give commission net of discounts and refunds, per shop.
- **Who sees it:** `compensationAccess(ctx, staffId)` returns `{ view, edit }`. It's never true for your own record or for a shop login. The new permissions are `compensation.view`, `compensation.edit`, `compensation.settings` (brand-only) and `compensation.own` (your own pay on My pay); Brand Admin has all four. The new report is `commission_payout`.
- **Tips:** `effectiveMethod(shop, policy, choice, planned?)` and `netsCardFee(shop, planned?)` take the plan's say from `tipOverrides(staffIds)`, while compensation is on.

### Event log (core)

Append-only `analytics_events`, written by database triggers on the tables both sides already write (see README, "Event log and operations KPIs" and "Event log schema"). The catalog is `EVENTS` and `EVENT_COLUMNS` in `src/domain/analytics.ts`; server code is `src/server/analytics.ts`.

- **Nothing is needed in `/api/v1`.** Bookings, cancellations, moves and tickets made through it are logged by the triggers. An appointment with `source = 'api'` is logged with channel `app` and actor `client`. The web client's `x-client: web` keeps it `online`.
- **Never write to `analytics_events` directly** except through `recordEvent` (server) or the funnel endpoint. Updates and deletes are refused by trigger, except the client id on merge and erasure.
- **Actor and device:** a transaction run inside `withEventContext({ kind, channel, device, staff })` from `src/db/event-context.ts` hands that context to the triggers. `safe()` and `authorize()` do it for staff server actions. Without one, the row's own source decides, and the device is blank.
- **Erasure:** deleting a `customers` row runs `analytics_forget` by trigger. A soft delete or anonymise should call `select analytics_forget(id)` itself.
- **Funnel:** `POST /api/events/funnel` (core-owned, CORS open, no auth) takes `funnelBeacon`: `{ funnel, step, shop, services?, staff?, anyBarber?, startsAt?, appointment?, channel? }`. `shop` and `staff` can be ids or slugs, and `appointment` an id or code. `step` is `viewed`, `service_picked`, `barber_picked`, `time_picked`, `details` or `booked`. Funnels with no booked step after an hour are logged `funnel.abandoned` by the nightly cron.
- **Post-visit rating:** `visit_satisfaction` (one per `sale_id`, `stars` 1-5, `channel` `receipt` or `app`). Only ask when `loadAnalyticsSettings().satisfaction` is on.
- **Migration `core_0059_analytics`.** Permissions: `analytics.events`, `analytics.export` (brand-level, owner grants), `analytics.settings`.

### Locations API, deep links and the booking widget

- **Handlers:** `getLocations` and `getLocation` in `src/server/locations-api.ts` (built with `route`, `json` and `query` from `api.ts`; no sign-in, `Cache-Control: public, max-age=60`). Core serves them at `/api/locations` and `/api/locations/{slug}`, plus a standalone document at `/api/locations/openapi.json`.
- **Shapes:** `LocationSchema`, `LocationListSchema`, `LocationQuerySchema` and `LOCATIONS_OPENAPI` (paths `/locations` and `/locations/{slug}`; components `Location` and `LocationList`) in `src/domain/location-profile.ts`. Query: `near=lat,lng` or `zip=NNNNN`, optional `radius` (miles) and `serviceId`. A location has the address (`line1`, `line2`, `city`, `state`, `zip`, `full`), `geo` (`approximate` when it's the ZIP centre), `distanceMiles`, `phone` and `textNumber` (`e164`, `display`, `href`), `email`, `timezone`, `hours`, `weeklyHours`, `closures` (next 90 days), `openNow`, `openStatus`, `nextAvailable` (first slot in 14 days with its `bookUrl`), `links` (`booking`, `app`, `embed`, `location`, `map`, `directions`, `review`), `googlePlaceId`, `social`, `photos`, `logoUrl`, `directions` and `amenities`. The tax jurisdiction is never in it.
- **Deep links:** `https://<site>/book/<slug>?service=<slug or id>&barber=<slug>&start=<ISO>&coupon=<code>`, the same as `rayz://book/<slug>?…` in the app (`deepLinks()`, `APP_SCHEME = "rayz"`), and `/embed/book/<slug>?…` for frames. The web booking flow already honours all four parameters.
- **Widget:** `<script src="https://<site>/widget.js" async>` with `<div data-rayz-booking data-location="<slug>">` (inline) or `<button data-rayz-book data-location="<slug>">` (opens over the page); `data-service`, `data-barber`, `data-start` and `data-coupon` pre-fill it. The frame posts `rayz:height` and `rayz:booked` (`{ type, location }` only, never the client or code). Bookings from it have funnel channel `widget`.

### Staff app API: `/api/staff/v1`

- **What it is.** The staff mobile app's API (Ray'z's replacement for Squire Commander), core-owned and apart from the customer `/api/v1`. Nothing under `/api/v1` calls it or changes for it. The OpenAPI 3.1 document is `GET /api/staff/v1/openapi.json` (`staffOpenApiDocument` in `src/server/staff-api/openapi.ts`); it lists each path's permission. The handlers are in `src/server/staff-api/handlers.ts`; each route file is a one-line re-export plus `OPTIONS`.
- **Sign-in (staff, never the customer OTP).**
  - `POST /auth/login` takes `{ email, password, deviceName? }` and returns `{ tokens }`, or `{ twoFactor: { ticket, enroll? } }` when the person has two-step sign-in.
  - `POST /auth/login/code` takes `{ ticket, code }`. A wrong code is 401 with `details.twoFactor`, to try again.
  - `tokens` is `{ accessToken, refreshToken, tokenType: "Bearer", expiresIn: 3600, sessionId }`. Access tokens (JWT type `staff_app_access`) last an hour; refresh tokens last 30 days and rotate on `POST /auth/refresh`. Reusing a rotated one ends every app session for that person. `POST /auth/logout` (204) ends the session, its access token and its phone's pushes at once.
  - Rate limits: 30 attempts per IP and 10 per email per 15 minutes. Each sign-in is audited `staff.login` with `via: "staff_app"`.
  - The web's rules apply on every request (`staffContextOf` in `src/server/auth/staff.ts` is shared with the web cookie): inactive or offboarded people, Sign out everywhere (`sessions_valid_after`), location sign-in rules, and roles, overrides and their expiry, shop scope and per-shop roles.
- **Headers.** `Authorization: Bearer <accessToken>` on everything but sign-in. `X-Shop-Id` picks the shop to work in (or `all`, where the role allows), the same as the web's shop switcher. `X-Clock-Device` is the front-desk clock token from `POST /clock/kiosk/register`.
- **Endpoints and who may call them** (checked on the server by `staffRoute` in `src/server/staff-api/http.ts`, then record by record in the shared server code):

  | Endpoint | Needs |
  | --- | --- |
  | `GET /me` (features and permissions), `GET`/`PUT /me/notifications` | signed in; notifications are personal |
  | `GET /schedule`, `GET /appointments` | their own only (not a shop login) |
  | `GET /appointments/{id}` | their own, or anyone's at their shops with `calendar.view_all` or `calendar.manage`; otherwise 404 |
  | `GET`/`POST /appointments/{id}/notes` | `notes.view`; private manager notes need `notes.private`; each read goes in `client_access_log` |
  | `GET /clock`, `POST /clock/punch`, `POST /clock/breaks/start`, `POST /clock/breaks/end`, `PUT /clock/pin` | `timeclock.punch`, personal |
  | `POST /clock/kiosk/register` | `settings.shop` at that shop |
  | `GET /clock/kiosk/team`, `GET /clock/kiosk/qr`, `POST /clock/kiosk/status`, `POST /clock/kiosk/punch` | `timeclock.kiosk` and a registered `X-Clock-Device`; each person's own PIN |
  | `GET /tips`, `GET /payouts`, `GET /banking`, `GET /banking/external-accounts`, `POST /banking/onboarding-link`, `POST /banking/dashboard-link`, `PUT /banking/method` | `tips.own`, personal |
  | `GET /earnings` | each part separately: sales need `reports.money` and `report.my_sales.view`, tips need `tips.own`, commission needs `compensation.own` with compensation on. A part they can't see is null; with none of them it's 403 |
  | `GET /popups`, `POST /popups/seen` | signed in |
  | `GET`/`POST /devices`, `PATCH`/`DELETE /devices/{id}` | personal |
  | `POST /me/step-up` | signed in; their code or password |
  | `POST /clock/kiosk/pair` | a manager's one-time pairing code (no sign-in); later kiosk calls take `X-Clock-Device` and `X-Device-Id` |
  | `PUT /banking/deposit-consent` | `tips.own`, personal |
  | `POST /auth/wiped` | the session's last refresh token |
  | `GET`/`POST /me/pay-questions`, `POST /me/pay-questions/{id}/escalate`, `POST /me/pay-questions/{id}/resolve` | `timesheet.own`, personal |
  | `GET /pay-questions`, `POST /pay-questions/{id}/answer` | `timesheet.approve`, `payroll.run`, `payroll.export` or `payroll.approve` at the shop, never their own; escalated ones need an owner or `payroll.approve` |

- **Time clock (S2), never biometric.** A phone punch proves where it is the way the shop asks. The front-desk QR code (changes every 30 seconds) and the shop's NFC sticker both open `/admin/clock?shop=<id>&qr=<code>` or `&tag=<tag>`; the app reads `shop` and `qr` or `tag` from that link and sends them as `proof`. Wi-Fi and location (`gps`) work as on the web. The front-desk tablet (`/clock/kiosk/*`) punches anyone on the team with their own PIN, which locks after 5 wrong tries. No face, fingerprint or other biometric is asked for or kept; a shop's optional punch photo is never matched. Breaks take the shop of the current shift. Clocking in returns `welcome` (milestones), already marked seen.
- **Banking (each employee's own Stripe Connect Express account, apart from the shops').** `POST /banking/onboarding-link` starts or resumes Stripe's hosted onboarding (identity, a bank account, and a debit card for instant payouts) and returns `step` (`start`, `resume`, `update` or `done`); Stripe sends the browser back to `/staff-app/stripe?stripe=return|refresh`, which opens `${STAFF_APP_SCHEME:-rayzstaff}://banking?stripe=…`. Then call `GET /banking?refresh=1`: status, `onboarding`, `requirements` (`due` and `pending` as `{ key, label }`, `deadline`, `disabledReason`), the default destination, and `instant` (`allowed`, `eligible`, `to` the card instant payouts go to, `feePaidBy`, `fee`). `GET /banking/external-accounts` lists every bank account and card (type, name, last 4, default, instant). `POST /banking/dashboard-link` is a one-time sign-in to their Express dashboard. Only Stripe ids, statuses and the type, name and last 4 are stored or returned. In the simulator the link is null and setup finishes at once. Test mode only (see "Tip payouts").
- **Pop-ups.** `GET /popups` returns unseen milestones (sales amounts only with `reports.money`), `open_shift` for a shift never clocked out, and `clock_in_reminder` when they're off the clock and their first client or shift starts within 30 minutes.
- **Push for their own bookings.** `POST /devices` registers the phone in `staff_devices` (5 at most per person; a token moves to whoever signs in on it). A first phone turns on push for new, changed and cancelled bookings if they never picked. `queueStaffAlert` (`src/server/staff-alerts.ts`) queues one `push` job per phone, with `to` the `staff_devices` id, kind `staff_confirm`, `staff_reschedule`, `staff_cancel` or `staff_arrived`, and data `{ kind, appointmentId }`. Never when they made the change themselves. APNs sends staff phones under `STAFF_APNS_BUNDLE_ID` (the same key signs for both apps).
- **Migration `core_0099_staff_app`:** `staff_app_tokens` and `staff_devices`. Offboarding revokes both. Later: `core_0102_staff_app_gaps`, `core_0103_staff_app_invite_jobs`, `core_0104_staff_payout_confirm_scrub` and `core_0105_tip_payout_periods`, then the payouts, payroll and staff delta migrations up to `core_0125_pay_questions_scrub`; the next free number is `core_0126`.
- **New env:** `STAFF_APNS_BUNDLE_ID` (the staff app's iOS bundle id; the customer app's when unset) and `STAFF_APP_SCHEME` (the staff app's URL scheme; `rayzstaff` when unset).
- **The builder's gap list (2026-10-27): ST-C1 to ST-C10, ST-I1 to ST-I8 and ST-I10 are in.** The OpenAPI document lists every new path with its permission (calendar, clients, timecards, earnings by pay period and YTD, payout setup and cutover, time off, walk-ins, sales and Terminal, the front-desk screen, the manager board, sessions, invites, code sign-in). Every route runs `staffRoute`: the staff app's own version gate (`STAFF_APP_{IOS,ANDROID}_MIN_VERSION`, 426 everywhere but `/config`), then the token, then `X-Shop-Id` through `assertShopAccess`, then `authorizeContext`. Path ids go through `assertShopAccess` or `requireInTenant`.
- **Card tips go straight to employees' banks through Stripe (ST-C7, ST-I9; Charles's decision).** `FEATURE_STAFF_STRIPE_PAYOUTS` is on unless `false`: `/banking` works, `GET /me` has `features.banking: true`, `GET /config` has `payouts: { defaultMethod: "stripe", stripe: true }`, and `GET /me/payout-setup` returns `defaultMethod: "stripe"` with each shop's method and a W-2 note. A shop set to pay through payroll still shows `payroll`. With the flag `false`, every `/banking` route is 403 with `details: { feature: "staff_stripe_payouts", enabled: false }` and everything reads payroll. The switch is `src/server/tips/payout-model.ts`. The tips are W-2 wages either way: every direct payout goes to iSolved as tips already paid, reconciled per employee and pay period.
- **Cash tip declarations (SB-C3, 2026-10-27).** `GET /tips/declarations?from=` (default the last 62 days) returns `rules` (`enabled`, `atClockOut`, `attestation`, `lockDay`), `reminder` (last month, when it's due) and `declarations` (each with `current` and `closesOn`). `POST /tips/declarations` takes `{ shopId, businessDate, amountCents, attest: true, replacesId?, reason? }` (a correction needs `reason`) and returns 201 `{ id, businessDate, amountCents, replacesId }`. `GET /clock` has `cashTips: { attestation } | null`; where it's set, `POST /clock/punch` with type `out` takes `cashTips: { cents, attest: true }` and the reply's `cashTips` is `{ declared, error }`: the punch stands either way. Both need `tips.own`.
- **Known gaps, for the app builder's list:**
  - The app sends no approved-device evidence, so a location whose sign-in rule needs an approved device or its Wi-Fi blocks the app away from that network.
  - A location block that starts after sign-in turns token requests into 401 "Please sign in again"; signing in again then shows the block message (403, `details.networkBlocked`).
  - Shop goals (ST-I2): the platform has none, so `/me/milestones` shows personal ones only.

## Requests for the other agent

- (core → mobile) When you add the platform Stripe Customer and saved cards, pass the platform Customer id into `chargeCard({ customerId, paymentMethodId, ... })` in `src/server/payments/processor.ts`. That function routes the charge to the shop's connected account (I10), so a saved card can pay at any shop. Please don't create PaymentIntents anywhere else.
- (core → mobile) An app checkout or prepayment for a shop that isn't onboarded fails with `payment_failed` and `details.reason = "payments_not_ready"`. Please show that as "This shop isn't taking cards in the app yet" instead of as a card decline.
- (core → mobile) Card charges should now go through `chargeRoute` (see "Per-location banking"). A cash-only shop fails with `details.reason = "cash_only"`; please show it as "This shop takes cash only" and don't offer card prepayment there.

- (core → mobile) Twilio now handles STOP and START on each shop number and writes `contact_opt_outs`. If the app shows a client's text consent, please treat a number in `contact_opt_outs` (channel `sms`) as not texting, whatever `sms_opt_in` says.

- (core → mobile) Locations now have a lifecycle in `shops.status`: `setup` (hidden from clients), `live`, `closed` (temporary, with `closed_until` and `closed_note`) and `archived` (`active = false`, which a database check enforces). The pure rules are in `src/domain/location-lifecycle.ts`: `listedPublicly`, `takesOnlineBookings`, `closedOn` and `operational`. PR #8 adds `shops.launch_at` and `booking_mode` as a cutover gate from Squire. That's a separate question (which system takes the bookings), so they should be combined rather than replace each other. Please have `/api/v1` list and book only shops where both the cutover gate and `takesOnlineBookings` allow it. Archived shops should never appear. Temporarily closed shops can be listed with `closed_note`.
- (core → mobile) Today's open-chair and rebook texts read `customers.sms_marketing_opt_in` from PR #8. They check for the column at runtime and send nothing until it exists. Core doesn't add the column; the consent UI and its capture are yours.
- (core → mobile) The Campaign Center (see "Campaign Center") reads these PR #8 names:
  - `customers.sms_marketing_opt_in`, `email_marketing_opt_in` and `push_marketing` (booleans);
  - `customer_devices.push_enabled`, `revoked_at` and `last_seen_at`.

  Please confirm the names, or tell us yours, and we'll change `src/server/marketing/consent.ts`. Please also:
  - capture marketing consent separately from appointment messages, with the TCPA disclosure;
  - treat a `marketing_unsubscribes` row as "off" for that channel in the app's settings, and record an in-app opt-out there (`source` `staff` or a new `app` source we'd add);
  - tell us when real push delivery replaces the `expo` stub. Jobs carry the device id in `to`.

- (core → mobile) Processor-hosted data: the server now scrubs card, bank, SSN and EIN values from every log line (`src/instrumentation.ts` wraps `console`, which covers `errorResponse` in `api.ts`), from audit details, and in the database from every free-text column, including what `importer.ts` writes. Please never add a request or response field for those values to `/api/v1`, `api-schemas.ts` or `openapi.ts`; `tests/db/sensitive-data.test.ts` checks every `/api/v1` GET and the OpenAPI document with `findSensitive`. When the app adds saved cards, collect them with Stripe's mobile Payment Sheet or SetupIntents and keep only the PaymentMethod id, brand and last 4.

- (core → mobile) If the app shows hours or adds a clock-in, please read and write through `src/server/time-clock.ts` (see "Time clock"). Never return `clock_pin_hash`, punch photos or other people's punches from `/api/v1`.

- (core → mobile) Family accounts: please mount the six `/api/v1/me/family` routes from `@/server/family-api` and spread `FAMILY_OPENAPI` into `openapi.ts` (see the family accounts log entry). In the app, book a family through `POST /me/family/bookings`, and show `household: true` from `/me/loyalty` as the family card.

- (core → mobile) Family booking in the app: verify the phone by code before listing the family, then multi-select who it's for, with an inline Add a child (see the family booking flow log entry).
- (core → mobile) Family booking groups: please mount the seven `/api/v1/me/family/booking-options` and `booking-groups/...` routes, show the slot finder's three plans with the total window, and show the 409 `alternatives` (see the family booking groups log entry).

- (core → mobile) Time between visits: the web account page (`/account`) shows the client's cadence, worked out in the browser from `/me/appointments` (only the latest 20 past appointments, so it can drift for clients with many cancellations). For the app, and so both read all visits, please add to `/me` (or a `/me/visits/cadence`) the result of `clientCadence(customerId, now)` in `src/server/visit-cadence.ts`: `cadence` (`visitDays`, `cadenceDays`, `label`, `lastVisit`, `sinceDays`, `nextExpected`, `booked`, `status`) and `barbers` (per barber, only when they've seen two or more). Labels and status words are in `src/domain/visit-cadence.ts`; once it's there, `/account` will read it instead.

- (core → mobile) **Withdrawn 2026-10-27:** the staff app's endpoints no longer go under `/api/v1/staff`. Core serves them at `/api/staff/v1` (see "Staff app API"), client notes included. Please don't add staff routes to `/api/v1`.
- (core → mobile) Core edited two files you own for the staff app's push. Please review:
  - `src/server/notifications/push.ts`: `NativePush` looks a device id up in `customer_devices`, then `staff_devices`. Staff phones use the topic `STAFF_APNS_BUNDLE_ID`, and a dead token revokes the row in whichever table holds it.
  - `tests/consent.test.ts`: one staff phone added to the APNs test.

- (core → mobile) Company-wide clients (see the log entry): if the staff app or `/api/v1` searches clients for staff, please call `searchClients` (or `findClients` plus `clientHits`) instead of anything shop-scoped, and on any staff client profile show other shops' visits without their prices or tickets to a shop login. Optional, in `importer.ts`: map a clients file's Birthday column (`FAMILY_ALIASES.birthday` in `src/domain/family-import.ts`) onto `customers.birthday` when it's empty. The core post-step already does this after each run, so it's only for imports that skip the admin action and the CLI.

- (core → mobile) Compensation fields (see the log entry): please don't return anything from `staff_compensation`, `staff_custom_fields` or `staff_custom_values` through `/api/v1` until it's needed, and then only through `compensationAccess`. The staff app's pay is core's now: `GET /api/staff/v1/earnings` returns the signed-in person's commission with `compensation.own` (see "Staff app API").

- (core → mobile) Event log (see "Event log" above), all optional:
  - In the app's booking flow, send the same funnel steps as the web wizard to `POST /api/events/funnel` with `channel: "app"` and a random `funnel` id per attempt, so the funnel compares app and web.
  - If the app asks "How was your visit?", insert into `visit_satisfaction` with `channel = 'app'` (first answer stands).
  - Wrapping `/api/v1` handlers in `withEventContext({ kind: "client", channel: "app", device: deviceClass(ua) })` would fill in the device for app bookings.
  - If account deletion is a soft delete, call `analytics_forget(customerId)`.

- (core → mobile) Location profiles (see "Locations API, deep links and the booking widget" and the log entry):
  - Please mount `getLocations` and `getLocation` from `@/server/locations-api` at `/api/v1/locations` and `/api/v1/locations/{slug}` (with `OPTIONS`), and spread `LOCATIONS_OPENAPI` into `openapi.ts`.
  - Add `address2` (the suite or unit line, `''` when none) to the v1 Shop schema, and prefer `fullAddress()` from `src/domain/location-profile.ts` wherever the app shows an address.
  - Register the `rayz://book/<slug>` deep link in the app with the same `service`, `barber`, `start` and `coupon` parameters.
  - If the app sends funnel steps, keep `channel: "app"`; `widget` is the embedded web widget's.

- (core → mobile) Staff milestones (see the log entry):
  - In `importer.ts`, when a Squire staff export has a hire or start date, please write it to `staff.hire_date` if that's empty (a date on or after 1950-01-01, not in the future). Anniversaries count from it. Past anniversaries (more than 2 days back) go in the trophy case without an announcement.
  - Optional: if Squire's export has lifetime totals from before the imported history, upsert `staff_milestone_baselines` (`staff_id`, `metric` in `services`, `clients`, `new_clients`, `rebooks` or `products`, `count`, `as_of` = the first day of the imported history). Core adds everything on or after `as_of`, so please don't include imported visits in the count. Leave a row the brand already entered (`set_by` not null) alone.
  - Please never return `hire_date`, `birthday_month`, `birthday_day` or anything from the `staff_milestone*` tables through `/api/v1`.

- (core → mobile) **Tip money movement for ST-C11 (2026-10-27, replaces the earlier money-movement request).** Stripe can't transfer from a shop's connected account to a barber's, so core removed that path (`payOutToConnectedAccount`, `unwindPayOut`). Until Charles signs off ST-C11 (separate charges and transfers), nothing moves tips; they're owed and go through payroll. When ST-C11 is approved, since you own Connect charges:
  - Implement `MoneyMovement` from `src/server/payments/money-movement.ts`: `send(t: TipTransfer, save)` sends `t.amountCents` to the barber's recipient account `t.to` from the platform balance the shop's charges funded (`transfers.create` with `transfer_group: t.group`, or `source_transaction`), charging the shop `t.shopCostCents` (the amount plus an instant fee the shop pays), then their payout as `t.payout` says (standard, or instant to `t.payout.destination`). Call `save(ids)` after each step so a retry resumes. `unwind({ key, ids, transferReversed, metadata })` puts back what was sent and is safe to call twice. Use `moneyClient()` so the test-mode guard holds, and idempotency keys starting with `t.key`.
  - Register it once at start-up with `registerMoneyMovement(impl)`. `directPayoutsAvailable()` then turns true and owed payouts held as `transfers_pending` can be released or sent.
  - Read barbers' accounts from `staff_payout_accounts` (`stripe_account_id`, `state`, `transfers_capability`), never `shop_payment_accounts`. Only `active` or `requirements_due` can be paid (`canReceive` in `src/server/tips/accounts.ts`).
  - The Connect webhook's staff branch now calls `handleStaffConnectEvent` and `isStaffAccount` from `src/server/tips/connect-events.ts` (core edited `connect-webhook.ts` for that; please review). Please add `capability.updated` and `account.application.deauthorized` to the Connect endpoint's events.
  - `src/server/payments/webhook.ts` (`charge.dispute.created`) calls `recordTipDispute`; please keep it when you change disputes.
- (core → mobile) Core edited the two `.well-known` routes (`apple-app-site-association`, `assetlinks.json`) to add the staff app's universal links and App Links (`src/server/staff-app-links.ts`) next to the customer app's. Please review, and keep `withStaffAppleLinks` / `withStaffAssetLinks` when you change them.

- (core → mobile) **No biometrics in either app (ST-I17).** Please run `node scripts/check-no-biometrics.mjs` (copy it from this repo, it has no dependencies) in the CI of the customer app and the Ray'z Staff app repos, on every pull request, as `.github/workflows/no-biometrics.yml` does here. It fails on face, fingerprint, voice or ID-verification SDKs (face-api, ML Kit or Vision face detection, ARKit face tracking, Rekognition, FaceTec, Onfido, Stripe Identity and the like) in `package.json`, lockfiles, `app.json` plugins, Podfiles, Gradle files and source. The phone's own unlock through `expo-local-authentication`, `react-native-biometrics` or `react-native-keychain` is allowed (the app only gets yes or no). The policy wording is `NO_BIOMETRICS_POLICY` in `src/domain/biometrics.ts`.

- (core → mobile) **The staff delta (2026-10-27, see the log entry).** For the Ray'z Staff app builder:
  - Sign-in: handle `twoFactor.enroll` (set up the authenticator before the first sign-in completes), the 403 `stepUpRequired` on reveal (`POST /me/step-up`, then retry), and pairing the front-desk clock by the manager's QR code (`POST /clock/kiosk/pair`, then `X-Clock-Device` and `X-Device-Id`).
  - Banking: show `depositConsent.text` and record agreement with `PUT /banking/deposit-consent` before any Stripe setup; offer tips on the paycheck only where `policy.tipsOnPaycheck` is true.
  - Phone data: follow `GET /config` `dataProtection` (encrypted 24-hour cache of `X-Staff-Cache: offline-24h` responses only, app lock, snapshot blur, no copy or share), wipe on a 401 `details.wipe` and report it with `POST /auth/wiped`, and queue offline punches with `queuedAt` and `clientPunchId`.
  - A **Question my pay** screen on `/me/pay-questions` (ask, see the history, escalate to the owners, close), the agencies and the no-retaliation line from `GET /config` `payQuestions`, and a manager list on `/pay-questions`.
  - On the pay screen, label earnings with `paystub` from `GET /me/earnings` (the names on their iSolved paystub), memo tips shown as already paid.
  - In settings, explain `quietHours` from `GET /config` next to the notification switches, and link `/staff-app/privacy`. While `privacyNotice.reviewed` is false, show it as a draft.
  - Before each store submission, run `pnpm staff:release-check` (or push a `staff-app-v*` tag to run `.github/workflows/staff-app-release.yml`). It fails until the privacy notice's reviewer signs off its version in `src/domain/staff-privacy.ts`. For App Review, use the Demo Shop login (`FEATURE_STAFF_REVIEW_LOGIN=true` on the review deployment).
  - Optional, in `push.ts` (yours): a silent "wipe" push to a phone when its session is ended remotely, so it wipes before its next request. Today it wipes on the next 401.

- (core → mobile, optional) If the customer app gets an "I'm running late" button, please call `queueStaffAlert("late", appointmentId, { detail: "about N min late" })` from `src/server/staff-alerts.ts`, so the barber gets the same alert as when the desk marks it from the staff app. Nothing goes back to the client.

## Open questions

- C18 review login and the wallet fee: flags are off until Charles decides.
- I10 fee model: the platform keeps an application fee equal to the processing estimate, and doesn't return it on refunds, so each shop's P&L carries its own card cost. Charles to confirm, or name a platform margin on top.
- Payroll, pending Charles: Q11 (do clocked hours already include training? The C2 flag stays off), Q17 (the owner row and the Coralville NetComm gap, flagged and not fixed), the full-time hours basis and window (default: clocked worked hours over a rolling 4 weeks), and 2-decimal half-up rounding of the export (off).
- Time clock, pending the owner or the accountant:
  - Iowa and Illinois overtime rules. It's federal weekly-over-40 for now, with optional daily OT as a setting.
  - The exact iSolved import template: column names and earning codes. The layout is configurable.
  - Meal break rules: 30 minutes or more is unpaid by default, and the auto-deduction is off.
  - Each shop's real coordinates and network addresses. The seeded ones are approximate.
- Staff payout onboarding, pending Charles: someone who leaves before finishing Stripe setup has tips held for them with no other way out. A manager can take the payout out of the batch, but the next batch holds it again while their method is Stripe. To pay them another way, change their method to cash or payroll, then take the payout out. Should leavers be paid in their final paycheck as a rule?
- Compensation, pending Charles: the iSolved earning codes for the optional columns (defaults `E_Service Commission_Dollars`, `E_Product Commission_Dollars`, `R_Regular_Rate` and `E_Guaranteed Minimum_Dollars`, all settings). Also whether the guaranteed minimum counts commission and overtime toward the minimum (it does now; tips don't).

## Log

### 2026-10-27: core, the staff delta for Squire (ST-C0a to C18, I10 to I20, N7, N8), requests for mobile
- **Held:** ST-C5's exact punches, cross-shop weekly overtime and buddy-punch rules, until iSolved Time is decided; the basic time clock is unchanged. ST-C11 / I10 (separate charges and transfers) still waits for Charles; money movement stays abstract.
- **Migrations `core_0112_staff_login_hardening` to `core_0125_pay_questions_scrub`** (a pay question's detail and history are scrubbed like every note). The next free one is `core_0126`.
- **Sign-in (C0c), web and staff app alike:** 30 tries per address and 10 wrong passwords per email in 15 minutes; every 10th wrong password in a row locks the account (15 minutes, doubling, at most a day) with the rate limit's wording. A privileged role (`PRIVILEGED_PERMISSIONS` in `src/domain/staff-auth.ts`) must set up two-step sign-in: login answers `twoFactor.enroll`. A staff app session unused for 30 days ends. Each browser is its own session row (**My sign-in security**), and a new device sends an email.
  - **Step-up:** reveal, client export and refund need a sign-in or step-up in the last 15 minutes. In the staff app, revealing a client detail answers 403 with `error.details.stepUpRequired: "reveal"`; call `POST /me/step-up` (`{ code }` once they have an authenticator, else `{ password }`) and retry.
  - **Front-desk clocks pair by a manager's one-time QR code:** `POST /clock/kiosk/pair` (`{ code, deviceId }`, no sign-in) returns 201 `{ token, device }`. Send `X-Clock-Device: <token>` and `X-Device-Id: <deviceId>` on `/clock/kiosk/*`; no staff session is needed, and the token works from no other install. `/clock/kiosk/register` still works.
- **Tips (C0a, C0b, C15, C18):** Squire-imported tips stay out of the time clock CSV and the payout batches. Payable tips never go below zero, a tip in a held or approved payout is never clawed back (a refund is the shop's cost, the only option now), and card fees never come out of a tip (migration 0114 returned any fee on open payouts).
- **Imported bookings:** a Squire appointments import queues reminders only when the importer ticks **Send reminders** (off by default), and every reminder rechecks the client's consent when it sends.
- **Deposit consent (C17):** `GET /banking` adds `depositConsent` (`{ version, text, agreed, agreedAt, needsRenewal }`) and `policy.tipsOnPaycheck`. Show `text`, then `PUT /banking/deposit-consent` with `{ agree: true, version }`; `agree: false` withdraws. Changed wording answers 400 with `details.reason: "consent_version"`. Until they agree, Stripe tips wait as owed. Only where `policy.tipsOnPaycheck` is true (a brand flag, off) can `payroll` be picked in `PUT /banking/method`.
- **Cash tips (C16):** reminders on the 1st and a last call on the 9th; declarations close on the 10th. **Payroll (C13):** owed tips in payroll (`E_Owed Tips Paid In Payroll_Dollars`) and Stripe-paid tips (`M_Tips Paid By Stripe_Dollars`) get their own columns, only when someone has them; 45B is monthly, from 2025-01-01 at $7.25.
- **Cutover (C9), entities (I14), IL and IA rules (I16):** the per-shop tips cutover checklist (Saturday close, a three-way tie-out signed by the manager and then the CPA); a legal entity per shop with state registrations, and the employer on every punch, time entry, tip payout, declaration and locked period; the work state per shop with the state minimum wage, Illinois meal-period prompts (staff event `meal_break`, urgent) and missed-meal flags, and the Illinois paid leave report.
- **No biometrics (I17):** `pnpm check:biometrics` (`scripts/check-no-biometrics.mjs`) runs in CI; see Requests.
- **Phone data (I18):** `GET /config` adds `dataProtection` (`STAFF_DEVICE_POLICY` in `src/domain/staff-device-policy.ts`): encrypted cache, 24-hour TTL, app lock after 5 minutes in the background, snapshot blur, no copy or share, read-only offline. Every response has `X-Staff-Cache: offline-24h | none`; keep only `offline-24h`. Every refused session is 401 with `details.reason` and `details.wipe` (`all`, `cache` or `none`); after wiping, send `POST /auth/wiped` with `{ refreshToken, wipe }` (the last refresh token). Offline punches send `queuedAt` (when tapped, at most 24 hours before) and `clientPunchId` (sent once); they're flagged offline for the manager.
- **Demo Shop (I19):** one hidden shop and a reviewer login for App Review, on only with `FEATURE_STAFF_REVIEW_LOGIN=true`; set up with `pnpm staff:demo-shop` (`STAFF_APP_REVIEW_EMAIL`, `STAFF_APP_REVIEW_PASSWORD`). A fresh demo day at each sign-in, no web sign-in, and nothing that moves money or reaches a person (403 with `details.reason: "demo_shop"`).
- **Quiet hours (I20):** off the clock or on a break, non-urgent `sms` and `push` staff alerts wait for clock-in, the break's end or the next shift (9 AM with none, skipping time off), and no later than two hours before the appointment. Urgent ones (`arrived`, `late`, `waitlist`, `clock_out`, `meal_break`) and email go at once. The rules are in `GET /config` `quietHours`. A held push is a `notification_jobs` row with a future `run_at` and `held_for_staff_id`; `push.ts` needs no change.
- **Privacy notice and pay questions (I10):** `GET /config` adds `privacyNotice` (`{ reviewed, version }`) and `payQuestions` (`{ topics, managerDays, ownerDays, agencies }`). The employee's endpoints are `GET`/`POST /me/pay-questions` and `POST /me/pay-questions/{id}/escalate` and `/resolve` (`timesheet.own`). The manager's are `GET /pay-questions` and `POST /pay-questions/{id}/answer`. There's a new staff event `pay_question` (push by default) and a web page `/admin/pay-questions`. The cron deletes phones signed out more than 30 days ago, and punch photos older than 90 days unless a pay question is open. `pnpm staff:release-check` fails until a named reviewer approves the notice's version.
- **Paystub names (N8):** each shop in `GET /me/earnings` adds `paystub`: `[{ header, name, unit, amount, group, memo }]` under the iSolved earning names (Regular, Overtime 1.5, Comm Sales, Cash Tips Recd…), only the groups they may see. **Tip pools (N7):** rules only (`src/domain/tip-pool.ts`); there's no pool.
- **Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts` (customer), `connect.ts`, `processor.ts` or `push.ts` changed.** See Requests.

### 2026-10-27: core, payroll review (SB-C1, C2, C3, C6, C7, I2), FYI for mobile
- **Squire imports are out of payroll.** Payroll sales, tips, the run and the tip ledger skip `sales.is_imported` tickets and any sale with a `squire_import` payment. If the importer marks Squire tickets another way, please tell core so payroll matches.
- **Migration `core_0110_payroll_review`:** `tip_declarations` (append-only), `payroll_profiles.tipped_occupation_code`, the `after_payout` absorption kind and the `report.payroll_w2_codes.*` and `report.payroll_fica_tip_credit.*` permissions; `core_0111_tip_declarations_scrub` scrubs a declaration's reason. The next free one is `core_0112`.
- **Staff API (core's):** `GET`/`POST /tips/declarations`, `cashTips` on `GET /clock` and on clock-out (see "Staff app API").
- **The brand pay calendar is a payroll setting** (`brand_settings.payroll.calendar`); `PAYROLL_ANCHOR_END` is gone. `payPeriodFor(date, cal)` in `src/domain/payroll.ts` takes it; on the server use `brandCalendar()` from `src/server/payroll/groups.ts`. The time clock's `periodFor` is now async.
- **Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts` (customer), `connect.ts` or `processor.ts` changed.** No request.

### 2026-10-27: core, staff payouts (ST-I9, C12 to C15, I11 to I15), two requests for mobile
- **No transfer path until ST-C11.** Money movement is abstract; tips are owed and go through payroll. See Requests: the ST-C11 implementation is yours, registered with `registerMoneyMovement`.
- **Barbers' accounts are recipient accounts** with no Stripe dashboard, onboarded in the staff app (`POST /api/staff/v1/banking/account-session`, embedded components) or by Account Link to `/staff-app/stripe/return` and `/refresh`. Seven states in `staff_payout_accounts.state`.
- **Migration `core_0108_staff_payouts`:** `brand_settings.staff_payouts`, the account state columns, `payroll_employers` and `tip_ledger.employer_id`, `tip_absorptions`, `tax_form_checks`, hold kind `transfers_pending`, and the permissions `payouts.view`, `payouts.manage`, `payouts.chain` and `report.payroll_tips_paid.*`. `core_0109_tip_employer_backfill` tags tips written before their shop had a pay group once it has one. The next free one is `core_0110`.
- **Staff app:** `GET /banking` adds `state`, `stateLabel`, `dashboard`, `onboardingMode`, `instant.fee.terms`, `instant.accepted`; `PUT /banking/method` takes `acceptInstantFee` (the terms shown), required once per fee before instant payouts turn on (off by default). Payouts held `transfers_pending` read "Owed: paid through payroll unless sent first".
- **Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts` (customer), `connect.ts` or `processor.ts` changed.** Core edited `connect-webhook.ts`, `webhook.ts` and the two `.well-known` routes (see Requests).

### 2026-10-27: core, payroll reports and the iSolved export status, FYI for mobile
- **Reports → Payroll** (eight reports, `report.payroll_*`), brand-only by default and in `SHOP_LOGIN_NEVER`. Admin only; nothing in `/api/v1` or `/api/staff/v1`.
- **Migrations `core_0106_payroll_export_sends` and `core_0107_payroll_export_sends_scrub`:** the `payroll_export_sends` table (its note scrubbed) and the new report permissions for Brand Admin and Bookkeeper. The next free one is `core_0108`.
- `pnpm typecheck` now runs tsc with a 4 GB heap; the full project passes Node's default 2.2 GB.

### 2026-10-27: core, direct Stripe tip payouts on (ST-I9) with W-2 safeguards, FYI for mobile
- **Charles decided card tips go straight to employees' banks through Stripe.** `FEATURE_STAFF_STRIPE_PAYOUTS` now defaults on; `GET /config` `payouts` is `{ defaultMethod: "stripe", stripe: true }`, `GET /me` `features.banking` is true, and `GET /me/payout-setup` `defaultMethod` is `stripe`. Same shapes as before; only the values change. The banking routes, onboarding links (return to `/staff-app/stripe`) and payout webhooks are unchanged.
- **Migration `core_0105_tip_payout_periods`:** the `tip_payout_periods` table and `staff_payout_accounts.fees_payer` / `w2_tagged_at`. The next free one is `core_0106`.
- **Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts` (customer), devices and push, `connect.ts`, `auth/customer.ts` or `app-config.ts` changed.**

### 2026-10-27: core, the staff app's API gaps (ST-C1 to C10, I1 to I8, I10), FYI for mobile
- **Added under `/api/staff/v1`:** see "Staff app API". 53 route files, all through `staffRoute`; the staff app has its own version gate, so `/api/v1`'s is unchanged.
- **Held (Charles, W-2 tips):** ST-I9 and the employee Stripe Express payout work. Tips are paid through payroll (iSolved); direct Stripe payouts wait on `FEATURE_STAFF_STRIPE_PAYOUTS` (off). Lifted the same day: see the entry above.
- **Migrations `core_0102_staff_app_gaps`, `core_0103_staff_app_invite_jobs` and `core_0104_staff_payout_confirm_scrub`** (0103 lets a `staff_app_invite` notification job have no shop, like `staff_invite`; 0104 scrubs the dispute note). The next free one is `core_0105`.
- **Shared code it reads, unchanged:** `searchClients`/`clientHits`, `customerAccess`, `queueStaffAlert`, `buildPayroll`, `computeCardFee`. Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, devices and push, `connect.ts`, `auth/customer.ts` or `app-config.ts` changed. One optional request (running late, see Requests).

### 2026-10-27: core, everyone re-registers for Stripe payouts, FYI for mobile
- **Charles decided:** there's no migration of Squire staff Stripe accounts; every employee does fresh Express onboarding under Ray'z.
- **Added:** the payout onboarding tracker in the brand and shop admin, bulk invites by text or email with reminders, tip payouts held for the person (never lost) until they finish, and a cutover checklist item (everyone onboarded before Squire's payouts stop). See "Tip payouts".
- **Staff API (core's):** `GET /banking` gains `waitingForSetup` (`{ cents, payouts }`). Each payout in `GET /payouts` gains `waitingForSetup` (true while it's held for their setup, with `statusLabel` "Waiting for your Stripe setup"), and the response gains a `waitingForSetup` total. The app can show "tips are waiting" from these. The banking screen at `rayzstaff://banking` is where invites land.
- **Migration `core_0101_staff_onboarding`.** It adds `staff_onboarding_invites`, `tip_payouts.hold_kind` (backfilled) and `shop_cutovers.squire_tips_end_on`. The next free one is `core_0102`.
- Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, devices and push, or `connect.ts` changed. No request.

### 2026-10-27: core, staff Stripe tip payouts (S3), one request for mobile
- **Scope from Charles:** the staff app's Stripe tip payouts, matching Squire Commander. Each employee has their own Stripe Connect Express account, separate from the shops' accounts. Stripe-hosted onboarding is launched from the staff app and covers identity, the bank account and a debit card for instant payouts.
- **Staff API:** `POST /banking/onboarding-link` starts or resumes onboarding (it returns `step`: `start`, `resume`, `update` or `done`). `GET /banking` now also returns the requirements, the onboarding step and the instant payout terms. New `GET /banking/external-accounts` lists every bank account and card, with last 4 only. `POST /banking/dashboard-link` links to the Express dashboard (see "Staff app API").
- **Money:** manager-approved payouts move from the shop's connected account to the employee's account through `src/server/payments/money-movement.ts`, then pay out on the shop's schedule, standard or instant to the debit card. The brand decides whether the instant fee is passed on (see "Tip payouts"). Webhooks: `account.updated`, `payout.paid` and `payout.failed`, plus external account changes.
- **iSolved:** tips already paid out get a memo column (`M_Tips Paid Out_Dollars`, the code to confirm with Charles).
- **Test mode only:** new env `MONEY_MOVEMENT_LIVE` (off). Live keys are refused for this until it's set.
- **Migration `core_0100_staff_tip_stripe`.** The next free one is `core_0101`.
- **Request:** a single money-movement module for both sides (see Requests). Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `connect.ts` or `processor.ts`'s charge path changed.

### 2026-10-27: core, the staff app API (`/api/staff/v1`), FYI for mobile

- **New scope from Charles:** a staff mobile app to replace Squire Commander. The Rayz App builder is auditing Commander and will send its API gaps. For now the platform has the staff namespace `/api/staff/v1`, core-owned and kept apart from your `/api/v1` (see "Staff app API" above for endpoints, sign-in, headers and permissions).
- **Covers:**
  - staff sign-in, apart from the customer OTP: email and password, the authenticator step, rotating refresh tokens and sign-out;
  - their schedule and their own appointments;
  - client notes on those appointments, filtered by the permissions system;
  - the time clock (S2) with QR, NFC or the front-desk PIN, never biometric, and breaks;
  - their tips, earnings and payout history (S3);
  - Stripe-hosted debit card and bank setup, keeping ids, status and last 4 only;
  - milestone and clock-in pop-ups;
  - push for their own new, changed and cancelled bookings.
- **Roles and permissions are enforced on the server.** Every request rebuilds the person's context through the same `staffContextOf` the web uses, so roles, overrides, shop scope, location sign-in rules and Sign out everywhere all apply. `tests/db/staff-api.test.ts` covers it.
- **Migration `core_0099_staff_app`.** The next free one is `core_0100`.
- **New env:** `STAFF_APNS_BUNDLE_ID` and `STAFF_APP_SCHEME`.
- **Your files:** core edited `push.ts` and `tests/consent.test.ts` for staff phones (see Requests). Nothing under `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts` or `importer.ts` changed. The earlier requests to mount staff routes under `/api/v1/staff` are withdrawn.

### 2026-10-26: core, claude bot review 2 fixes, Connect handed to mobile, FYI for mobile

- **Stripe Connect per shop is mobile's now** (Charles's reassignment). That covers `stripeAccountId`, hosted onboarding, destination charges and the `owner_entity_id` hook. Until you publish the shared charge path here, the POS charges through `chargeCard` (`src/server/payments/processor.ts`), which routes through `chargeRoute` and `chargeDestination` (`src/server/payments/connect.ts`). When you publish it (its name, arguments, and what it returns for Terminal and keyed cards), core switches the POS, the customer screen and split tender to call it and deletes its own routing. Core won't change `connect.ts` in the meantime, other than for a bug you ask for.
- **Also yours, and core isn't touching them:** the consent overwrite fix (`customers.ts:110` and the importer), rate limits on `/api/v1`, the token check on `/appointments/{code}`, the other mobile API gaps, and the batched importer.
- **Core edited files you own, at Charles's request (review fix 10).** Please review:
  - `src/server/api.ts`: CORS is no longer `*`. `allowedOrigin()` echoes the app's own origin (`APP_BASE_URL`), anything in `CORS_ORIGINS` (comma-separated), and localhost when `NODE_ENV` isn't production. `withCors()` adds the headers and `Vary: Origin`; `route()` applies it to every response, and `options(req)` now takes the request.
  - Three 204 routes dropped their hard-coded `Access-Control-Allow-Origin: *`: `me/payment-methods/[id]`, `me/devices/[id]`, and `auth/logout`.
  - Requests without an `Origin` (the apps) are unaffected. If the app's web build or Expo web calls the API from another origin, add that origin to `CORS_ORIGINS`.
- **`DEMO_MODE` can't run in production** (`assertDemoModeAllowed` in `src/lib/deployment.ts`). The build (`scripts/deploy-db.ts`) and the server (`src/instrumentation.ts`) stop if `DEMO_MODE=true` comes with `APP_ENV=production`, a live Stripe key, or a real `NOTIFICATIONS_*` provider. Set `APP_ENV=production` on the production project.
- **Other review fixes (core):**
  - The web booking SMS box starts unticked.
  - A refund made in the Stripe Dashboard waits as an unallocated card refund until staff assign its lines. Loyalty and gift card balances don't move until then.
  - Pay reports are brand-only by default (`core_0098`).
  - Last names show as an initial for shop and barber roles.
  - The sales list pages 100 tickets at a time by key.
  - A job table fans work out per shop: badges, campaigns, scheduled reports, nudges and tip payout drafts.
  - Split tender charges the card fee on the credit part only.
  - A personal block covers all of the barber's shops by default.
- **Custom reports gain Sales, Appointments, Staff, Inventory, Tips and Campaigns sources** (no migration, no API change). A saved definition's `source` can now be any of `REPORT_SOURCES`; each has its own field keys (`FIELDS_BY_SOURCE` in `src/domain/report-builder.ts`). A result's `noun` can be `ticket`, `appointment`, `barber`, `product`, `tip` or `message` as well as `client` and `event`. Staff, inventory, tips and campaigns need their standard report's view permission (`sourceReport()`); `PanelSees.reports` lists the report keys a person may view. `outcomesSql` in `src/server/marketing/report.ts` is now exported for the campaigns source. Dollar fields need `reports.money` and each person's tips need `report.tips_payroll.view`; an event log `tip` row's amount is now null without the latter. If Rayz Assistant or the app reads saved reports, expect the new sources.
- **The staff app's look (no API change):**
  - Inter, and an opt-in dark mode under `/admin` only.
  - A Cmd-K palette and keyboard shortcuts.
  - `loading.tsx` skeletons and toasts.
  - A day board that pages barbers instead of scrolling sideways.
  - Checkout side by side on tablets.
  - Bar charts on reports.
  - WCAG AA contrast in both themes: as text only, `text-zinc-400` and `text-zinc-500` render as darker greys, and the pale 600 accents as their 700 shade. The public booking pages share `globals.css`, so they get the same text colours. No markup change is needed on your side.
- **Next migration number: `core_0099`.**

### 2026-10-26: core, report scope and dollar amounts, FYI for mobile

- **Migration `core_0096_report_scope_money`.** The next free one is `core_0097`. No schema change: it grants `reports.money` to every role (so nothing changes today) and `reports.all_shops` to `brand_admin` and `bookkeeper`, adds the `apprentice` template and renames `bookkeeper` to "Bookkeeper / Accountant".
- **New permissions:** `reports.money` (dollar amounts in reports; the QuickBooks journal needs it), `reports.all_shops` (reports on every shop for someone scoped to a few; includes `reports.all_staff`, never on shop logins) and `settings.app` (App switches; brand-only, Brand Owner grants).
- **If the staff app shows reports:** load them through `loadReport` in `src/server/report-data.ts` (it hides dollar amounts without `reports.money`) with the context from `reportContext(ctx, report)` in `src/server/report-access.ts` (it widens to every shop with `reports.all_shops`). Don't call `REPORT_LOADERS` directly.
- **Customer API:** no change. App switches read the same values; only who may change them moved to `settings.app`.

### 2026-10-26: core, roles and permissions, FYI for mobile

- **Migration `core_0095_roles_permissions`.** The next free one is `core_0096`. Adds `roles.money_limits` and `roles.owner_entity_id`, and `staff.money_limits`, `staff.permission_override_expires` and `staff.scope_region_id` (with `shop_scope = 'region'`, kept in step with `shops.region_id` by triggers). New templates `bookkeeper` and `marketing`; `regional_manager` is now named "Regional / District Manager".
- **New permissions:** `sales.void` (split from `sales.refund`), `calendar.view_all` (from `calendar.manage`), `staff.view` (from `staff.manage`) and `exports.accounting` (the QuickBooks journal). Everyone who had the original got the new one, so nothing changes for staff using the app today.
- **If the staff app refunds or voids:** call the same server code. A refund or void over the person's dollar limit is refused with `forbidden` and details `{ approval, overLimit: true, limitCents }`; send a manager's approval (`{ staffId, pin }`) from someone whose limit covers it. Voids now check `sales.void`, not `sales.refund`.
- **Overrides can expire.** Read effective permissions through `loadStaffAccess` / `accessFor` (they drop an override after its end date). Don't read `staff.permission_overrides` directly.
- **Customer API:** no change.

### 2026-10-26: core, brand change scope, FYI for mobile

- **Migration `core_0094_brand_sync`.** The next free one is `core_0095`. Adds `shop_sync_state` (each shop's inherit or override per setting, and its own value for settings that used to be brand-only), `brand_sync_values` (brand templates for hours, taxes and receipt branding), `brand_sync_batches` and `brand_sync_changes` (every sync with each shop's old and new value, for undo), and `brand_sync_controls` (which settings shop managers may change). No new permission: each area uses the permission its brand editor already needed. New page `/admin/sync-status`, new cron `/api/cron/brand-sync` (every 5 minutes, runs scheduled syncs).
- **I touched two mobile-owned routes** (the booking switch per shop, see next point): `POST /api/v1/appointments` and `POST /api/v1/appointments/{code}/reschedule`. No request or response shape changed. Please review.
- **App switches per shop.** Booking and payments can now differ by shop (Setup → App switches syncs to all or some shops). A shop with booking off answers 403 `forbidden` with the same message and `switch: "booking"` detail on create and reschedule, as the app-wide switch did. Payments are checked per shop in `app-pay` the same way. `/app/config` `features.booking` and `features.payments` are true when any open shop has them on, so keep handling the 403 per booking. Family and marketing push stay app-wide. `APP_KILL` still turns anything off everywhere.
- **Shop-level values the app may see change:** checkout prompts, loyalty earning rules (minimum visit, products and tips counting), Campaign Center templates and role permissions can now be a shop's own. Loyalty points the app shows come from the server, so nothing to do. Services, products, hours, taxes, tips, card fee, receipt branding and booking policies keep their existing shop columns; a sync writes those, so `/shops/{shop}` and the services list read them as before.
- **Audit:** `brand_sync.apply`, `.scheduled`, `.run`, `.cancel`, `.failed`, `.push`, `.reset`, `.rollback` and `.control` on the batch; `brand_sync.shop` per shop with each setting's old and new value; plus each area's own entries with `via: "brand_sync"`.

### 2026-10-26: core, credit card surcharge policy (extends C7), for mobile

- **Migrations `core_0091_card_fee_policy` and `core_0092_card_fee_backfill`.** The next free one is `core_0093`. `core_0092` fills in the rate and basis of card payments from before tickets kept a pricing snapshot, from what was charged. Brand policy in `brand_settings.card_fee`, a shop's override in `shops.card_fee_override`, fee details and waivers on `payments`, `sales.card_fee_waived_cents`. New permissions `settings.card_fee`, `pos.waive_card_fee` and `report.card_fees.*`.
- **What the app sees (additive, API 1.2):** the ticket's `cardFee` adds `type`, `flatCents`, `capCents`, `minCents`, `wallets` and `off` (`channel_off` or `state_not_allowed`); `notice` is the brand's wording. The quote's `feeReason` adds `channel_off`, `state_not_allowed` and `waived`. Keep showing `feeLabel`, `feeCents` and `disclosures` from the quote before the customer authorizes, and quote again when the payment method changes. A ticket sent from the counter with the surcharge waived quotes 0 with `feeReason = waived`.
- **Wallets:** `FEATURE_WALLET_FEE` alone no longer surcharges Apple Pay or Google Pay; the brand also has to turn that wallet on (both off by default).
- **For Charles:** card-brand registration and notice rules, the state allowlist and limits, and the refund rule (Visa may require refunding it). `STRIPE_SURCHARGE_FIELD` stays off (Stripe preview).

### 2026-10-26: core, which shops use the credit card surcharge, for mobile

- **Migration `core_0093_card_fee_shops`.** The next free one is `core_0094`. Adds `shops.card_fee_changed_at`, filled from the audit log. `brand_settings.card_fee` gains `appliesTo` (`all`, `selected` or `none`; default `all`), `shopIds` and `shopsCanEdit` (default false). No new permission: `settings.card_fee` manages it on the new `/admin/card-fee` page.
- **No API change.** A shop the brand doesn't apply the surcharge to sends `cardFee.enabled = false`, and the quote's `feeReason` is `disabled`, as for a shop that turned it off. The app keeps reading both from the server.
- **Audit:** `card_fee.shops` (one per bulk action, with each shop's before and after), `card_fee.shop` per shop with `via` (`brand`, the bulk action, or `new_location`), and `card_fee.brand` lists which shops a brand save changed.

### 2026-10-26: core, customer app API 1.2 (C1–C22, I1–I16, P1), for mobile

- **Built here at the user's direction**, following the platform delta from the Ray'z App builder (second review). The OpenAPI document is 1.2.0, and its description lists every change. It's backward-compatible except that `chooseProfile` is never returned (treat it like `needsProfile`). Mobile: please rebase onto this branch and drop the overlapping work in PRs #2–#8 (devices, push, consent, saved cards, deletion, the importer changes).
- **Migrations `core_0083` to `core_0090`.** The next free one is `core_0091`. `core_0089` clears dependents' last name, full birthday, address, nickname, contact and consent, and deletes their photos. The `customers_family_guard` trigger now enforces that on every write.
- **What the app needs to change:**
  - Send `X-Client`. App booking is signed in only: a request without a token gets 401 `sign_in_required`.
  - Send `ageConfirmed` when a sign-in creates an account (400 `age_confirmation_required` if it's missing, 403 `under_13`).
  - Handle `stepUp` (reason `idle_number` or `secured`) and `cantSignIn`, and the identity check (`identityCheckRequired`, `POST /me/identity-check`).
  - Change email through `/me/email/start` and `/me/email/verify`.
  - Consent at `/me/consent`, devices at `/me/devices`, receipts at `/me/receipts`.
  - Cards at `/me/payment-methods` (PaymentSheet or FlowController with the setup response). Pay at `/me/tickets/{id}/quote`, then `/pay` with `expectedTotalCents`, which answers 409 if the total changed.
  - Deletion at `/me/delete`; "Secure my profile" at `PUT /me/secure`; `POST /me/family/claim`.
  - The family, badges and locations endpoints are now mounted under `/api/v1`. The family ones answer 403 `details.switch = family` when the switch is off.
  - Sessions (I12, `core_0090`): `GET /me/sessions`, `DELETE /me/sessions` (everywhere else), `DELETE /me/sessions/{id}`. Signing out or ending a session now stops its access token at once (401) and revokes the push devices registered in it, so register devices after sign-in with the new token. Access tokens issued before this deploy carry no session and run out within the hour.
  - `/me/appointments` takes `status` (upcoming, past, cancelled), `limit`, `cursor` and `family=true`, and returns `nextCursor` (I6). With no parameters the shape is as before.
  - `GET /me/loyalty/ledger` (I7), `GET /me/suggested-rebook` (I8) and `policies` on `GET /shops/{shop}` (I9). `homeShop` and `birthday` on `/me`, set with `homeShopId` and `birthday` on `PATCH /me` (C16; under 13 is refused).
  - `/app/config` adds `features` (kill switches), `links` (privacy, terms, support, deleteAccount), `payments` and `accounts`.
- **Flags that stay off until Charles decides:**
  - `FEATURE_REVIEW_LOGIN` (C18 App Review sign-in, with `APP_REVIEW_PHONE`, `APP_REVIEW_CODE`, `APP_REVIEW_SHOP` and `APP_REVIEW_EMAIL`), read through `flags.reviewLogin()`.
  - `FEATURE_WALLET_FEE`.
  - `STRIPE_CHARGE_MODEL` (I10; `on_behalf_of` by default, or `destination`).
  - `STRIPE_SURCHARGE_FIELD`, until Stripe signs off.
- **Time clock (P1):** QR and NFC checks next to device, network and GPS. No biometrics. The codes are HMACs under `AUTH_SECRET` (`src/server/clock-codes.ts`).
- **Not done:** deposits and no-show fees (I9 is the owner's decision; the policy text is shown), web Apple Pay domain verification, and Spanish (I13: there's no Spanish copy of service names, policies or message templates to serve, so server strings stay English and the app localizes its own UI). PR #1's checklist has every item with its status.

### 2026-10-26: core, customer app API 1.1 (first part), for mobile

- **Built here at the user's direction**, although `/api/v1` is mobile's area: the user asked core to close the app audit's gaps. Everything is additive and backward-compatible, and the OpenAPI document (now 1.1.0) covers it. Mobile: please rebase PRs #2–#8 onto this branch rather than re-adding these.
  - **`GET /api/v1/app/config`** (`src/server/app-config.ts`): versions, store links, maintenance, support and legal links, from env vars.
  - **Version gate in `route()`** (`src/server/api.ts`): `X-Client: ios|android` with an `X-App-Version` below `APP_<PLATFORM>_MIN_VERSION` gets 426 `upgrade_required` with `details.storeUrl`. The config and the spec are exempt, and no `X-Client` is never gated. CORS now allows `X-Client`, `X-App-Version`, `PUT` and `DELETE`.
  - **Migration `core_0082_customer_app`:** `shops.booking_mode` (`platform|external`) and `external_booking_url` (https, required for external, checked in SQL); `customers.preferences_note` (500 characters, scrubbed and contact-redacted by triggers) and `preferences_updated_at`.
  - **Booking mode:** `takesOnlineBookings` is false for an external shop, so online and API booking refuse it. Staff booking is unaffected.
  - **Preferences:** `PATCH /me` takes `preferencesNote` and `preferredBarberId` (`customers.preferred_staff_id`); `/me` returns `preferences: { note, updatedAt, preferredBarber }`. The staff `notes` column is never read or written by the app.
  - **App link files:** `/.well-known/apple-app-site-association` and `assetlinks.json` (env `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE`, `ANDROID_CERT_SHA256`; 404 until set).
- **Next from core, in this order:** C1 (OTP delivery providers), C2 and the rest of C13 (rate limits, sessions), C3–C5 (devices, push, consent; this adds `sms_marketing_opt_in`, `email_marketing_opt_in`, `push_marketing`, `deleted_at` and `customer_devices` with the names `src/server/marketing/consent.ts` already reads), C10 (deletion), C9 (receipts), then C6–C8 and C14 (Stripe), then I1–I13.

### 2026-10-26: core, sandbox status for Testing Bot (Charles asked)

1. **What's deployed or runnable today**
   - **Nothing is on Vercel or Neon.** No Vercel project is linked to the repo: PR #1 has no preview deployments and no deployment checks. The app runs anywhere with Postgres (`DEMO_MODE=true pnpm build && pnpm start`), and DEPLOY.md has the demo-preview steps.
   - **A temporary sandbox is up now:** https://stamp-appeared-coal-secrets.trycloudflare.com. It's a demo-mode production build of the latest core push (now `ef85b30`, API 1.2), served from the core agent's VM through a Cloudflare quick tunnel, with its own database (`rayz_sandbox`) and the full demo seed. Cards run on the simulator. No texts, emails, calls or push go out; they show under **Notifications** as suppressed.
   - **Limits of the temporary sandbox:**
     - It's up only while the core agent's VM is running, and the URL changes if the tunnel restarts. Check this entry for the current URL.
     - It doesn't pick up new pushes on its own. Core rebuilds it after each push in the mobile list below.
     - It has no password. The data is sample data only, but anyone with the link can use the demo logins.
   - **Test logins:**
     - **Staff** at `/login` (one-click buttons on the page), password `rayz2026!`: `owner@rayz.test`, `admin@rayz.test`, `michelle@rayz.test` (Coralville manager), `frontdesk@rayz.test`, `makenna@rayz.test` (barber), and shop logins such as `coralville@rayz.test`. Time clock and customer-screen PIN: `2468`.
     - **Customers** on the web at `/account`, or through the API (`POST /api/v1/auth/otp/start` with `{"phone":"319-555-0100"}`, then `/verify`). In demo mode the code comes back as `devCode` and shows on screen. Other phones: `319-555-0201` (the Hayes family, one phone, three profiles), `309-555-0202`, `563-555-0203`.
     - **Test data:** card "Visa (credit)" in checkout, gift card `DEMO-GIFT-2500`, promo `WELCOME5`. The OpenAPI document is at `/api/v1/openapi.json`.
   - **What the API at this URL covers:** all of customer app API 1.2 (C1–C22, I1–I16, P1; see the 1.2 entry above and the OpenAPI description). In demo mode codes come back as `devCode`, payments run on the simulator, and push and texts are suppressed. A phone shared by several profiles (the Hayes family) asks for a first name after the code; it never lists who's on the number. App bookings need a token and `ageConfirmed` when the sign-in creates an account. PR #7's sandbox is separate: a mock API on a laptop with code `123456`, not this platform.
2. **What's still needed for a lasting sandbox URL with test logins**
   - **From Charles (Vercel and Neon accounts, about 20 minutes, following DEPLOY.md, "Demo preview, step by step"):**
     - Create a Vercel project from `stephens818-maker/rayz-shop-platform`. Use the Pro plan, or Hobby with the cron schedules changed to daily.
     - Set **Production Branch** to `cursor/rayz-barbershop-v1-8f0b`.
     - Add Neon from **Storage**, in US East 2.
     - Set `DEMO_MODE=true`, `AUTH_SECRET` and `CRON_SECRET`, then deploy.
     - For protection, Vercel Authentication would also lock Testing Bot out. Use **Password Protection**, or **Protection Bypass for Automation** and give Testing Bot the bypass secret (sent as the `x-vercel-protection-bypass` header).
   - **Or** add a `VERCEL_TOKEN` (and optionally a Neon `DATABASE_URL`) under Cursor Dashboard → Cloud Agents → Secrets, and core does the setup.
   - **Then core:** checks every login and the API on the real URL, then posts the URL and the bypass instructions here.
   - **Optional:** Stripe test keys (`sk_test_…`, `pk_test_…`), to test real Stripe test mode instead of the simulator.
3. **Time estimate (hours of work, honest)**
   - **Temporary sandbox:** live now.
   - **Lasting Vercel sandbox:** about 1–2 hours after Charles finishes his part or adds the token: the first build with the seed, a login and API check, and the handoff note. The blocker is the accounts, not code.
   - **Mobile endpoints on the sandbox:** C1–C16 are roughly 12–20 hours, and I1–I13 another 8–12. The payments items (C6–C8, I10–I11) are the least certain. Each group is pushed and the sandbox rebuilt as it lands, so Testing Bot can start on the existing v1 flows now and pick up new endpoints as they appear.

### 2026-10-25: core (email delivery, calendar feed, delivery tracking), requests for mobile

- **What's new** (README, "Notifications"): real Resend and Postmark email (off until a key is set), client emails in the brand layout with a stop link, bounce and complaint webhooks, Google and Outlook add-to-calendar links, cancelled calendar events on cancel emails, a per-customer calendar feed, reminders kept out of quiet hours, and delivery status on the client profile, the appointment panel and Notifications → By shop. Migration `core_0081_email_delivery` (additive).
- **Consent (mobile's area), touched lightly, like STOP:** a hard bounce, a spam complaint or the stop link in an email sets `customers.email_opt_in = false` for every client with that address (case-insensitive) and records them in `email_suppressions.customer_ids`. Nothing else in core writes `email_opt_in`. Please don't turn it back on for an address in `email_suppressions`: the next email would be held back anyway, and the outbox says why.
- **`email_suppressions`** (`email` lowercase and unique, `reason` `bounce|complaint|unsubscribe|staff`, `provider`, `customer_ids`). Every email job to a listed address is suppressed at send time. If the app shows a client's email consent, treat a listed address as not emailing.
- **Calendar feed:** handlers `getCalendarFeed`, `postCalendarFeed` and `deleteCalendarFeed` in `src/server/calendar-feed-api.ts` (built with `route` and `json` from `api.ts`, signed-in customer). The web account page uses them at `/api/account/calendar-feed`. GET returns `{ on, createdAt, lastFetchedAt }` (never the URL); POST returns `{ url }` once (`https://<site>/cal/<token>.ics`) and ends any earlier link; DELETE returns `{ revoked }`. The feed has the customer's and their children's appointments.
- **Requests:**
  - (core → mobile) Please mount the calendar feed handlers at `/api/v1/me/calendar-feed` (GET, POST, DELETE) and add them to the OpenAPI doc, if the app should offer "Add my appointments to my calendar".
  - (core → mobile) Web Push (VAPID) for the booking site and the app's FCM/APNs device registration are still yours. When a provider replaces the `expo` stub, emails and texts need nothing from you; app push jobs keep the device id in `to`.

### 2026-10-25: core (Squire brand admin review: reports, staff, catalog, brand defaults, bulk edit, payouts, gift cards, memberships, phone agent), requests for mobile

- **What's new** (README, "Brand admin, against Squire's"):
  - **Reports:** grouped navigation, a last-business-day default that skips Sundays, the sales waterfall, Cash Register History, the Appointments report with its filters, the Commission Payout report in Squire's columns, and Analytics period over period with saved views.
  - **Staff:** a per-staff permission matrix, booking options (all shops or this shop only), notification channels and reminder timings, days on with history, and visible online.
  - **Brand:** the all-shops day board; one brand catalog with category order, a brand Products page and taxes by jurisdiction beside card fees; brand defaults inherited by locations, including GA4 and Meta Pixel on the booking site.
  - **Operations:** bulk edit and schedule templates; payouts matched to the bank; the Gift cards page with paid reloads at checkout.
  - **Memberships:** optional, billed with Stripe Billing.
  - **Phone agent page:** call log, outcomes, transcripts, follow-ups, settings, and optional speech.
- **Schema** (all additive):
  - `core_0070`: appointments report permissions.
  - `core_0071`: staff booking options. Adds `staff.booking_options`, `staff_shops.booking_options`, `staff.notification_prefs`, `staff_days_on`, `appointments.booking_tip_cents`, and the drawer move kind `no_sale`.
  - `core_0072`: register permissions (`drawer.no_sale`, `pos.custom_charge`).
  - `core_0073`: analytics and saved report views.
  - `core_0074`: catalog category order, high stock thresholds, and unallocated brand stock with its ledger.
  - `core_0075`: location defaults.
  - `core_0076`: schedule templates.
  - `core_0077`: `payout_reconciliations`.
  - `core_0078`: memberships. Adds `brand_settings.memberships_enabled`, `membership_plans`, `memberships`, `membership_invoices` and `membership_uses`.
  - `core_0079`: memberships permissions.
  - `core_0080`: phone agent. Adds `call_transcript_lines`, plus `call_logs.followed_up_at`, `followed_up_by` and `follow_up_note`.
  - Free-text columns have `scrub_sensitive_row` triggers.
  - **The next free number is `core_0081`.**
- **Nothing under `/api/v1`, `src/server/api*.ts`, `openapi.ts`, `auth/customer.ts` or `importer.ts` changed.**
- **Mobile, please:**
  - **Book without payment:** honor the per-barber `bookWithoutPayment` option (`staff.booking_options`, overridden per shop in `staff_shops.booking_options`; read it with `effectiveBookingOptions` in `src/domain/staff-booking.ts`) for `source = "api"` bookings. Web booking already enforces it.
  - **Staff push:** `staff.notification_prefs` has a `push` channel per alert (confirm, reschedule, cancel, arrived). Core sends email and SMS. Push needs your devices table, so please send it when you add staff devices.
  - **Importer:** before overwriting an imported gift card balance, the importer checks for ledger activity. Please add the new `gift_card_ledger` kinds `reload`, `reload_refund` and `comp` to that check, so a reloaded or comped card isn't overwritten on re-import.
  - **Memberships:** these use Stripe Checkout in subscription mode on the brand account and don't touch your Stripe Customers. If you want members to reuse their saved card, pass your Customer id into `enroll` (`src/server/memberships.ts`), which today lets Checkout create one. The webhook now sends brand-account `checkout.session.completed` (mode subscription), `invoice.paid`, `invoice.payment_failed` and `customer.subscription.*` to `applyMembershipEvent`, which ignores anything that isn't a membership.
  - **Optional API exposure:**
    - booking tip (`appointments.booking_tip_cents`);
    - per-barber booking options (max days ahead, minimum notice, cancellation cutoff, multiple services);
    - memberships (`clientMemberships`, and `checkoutCoverage` for a client app's own card);
    - `FinalizeInput.membershipId`, which is optional, so client API checkout is unchanged.
  - **`publicShopPage`** (`src/server/public.ts`) now also returns `headline`, `cancellationPolicy`, `noShowPolicy` and `tracking` (`ga4`, `metaPixel`) from brand defaults with the shop's overrides. Your public shop endpoint can pass them through.
- **New crons:** `/api/cron/memberships` daily (renews simulated memberships). It's a no-op when Stripe bills.
- **Tests:**
  - Unit: `tests/squire-brand.test.ts`.
  - DB: `tests/db/payout-reconcile.test.ts`, `tests/db/gift-cards.test.ts`, `tests/db/memberships.test.ts` and `tests/db/phone-agent.test.ts`, plus updates to the tenant, permissions and shop-login tests.

### 2026-10-25: core (Squire Engage parity: email design, texts, wizard, per-send results, loyalty program), FYI for mobile

- **What's new** (README, "Campaign Center" and "Loyalty"):
  - Campaign emails get a headline, a header image (uploaded, enhanced or cropped in the browser, with AI alt text) and a booking button in the location's accent color or the brand's red. "Refine with AI" rewrites any part and keeps its merge fields.
  - Marketing texts get the booking link and "Reply STOP to opt out." added at send time when the wording doesn't already have them, with a segment counter in the editor. Merge fields take fallbacks: `{first_name|friend}`. Without one, `{first_name}` says "there" and `{barber}` "your barber".
  - The blast wizard opens any step at any time, the review shows each channel's message with Edit links and blocks Send while anything is left to fix, and the audience shows each channel's reachable count of everyone matching.
  - Results: a repeating blast shows its last send beside its lifetime numbers (detail page and list), every send gets a full metrics row, and automated campaigns and lapsed sequences show results on their own pages (by week, and by step for sequences).
  - The loyalty program is set at brand level like Squire's: enabled, value or transaction based, include products and tips, assigned shops. Ray'z: value based, $15 per $300, products and tips off, every location but Dubuque.
- **Schema:**
  - `core_0068_loyalty_program`: `loyalty_ledger.unit` (`cents` | `visits`, default `cents`). `brand_settings.loyalty` gains `type`, `visitsGoal`, `minVisitCents`, `includeProducts`, `includeTips` and `shopIds` (null = every location; set to every shop but Dubuque where a Dubuque shop exists).
  - `core_0069_email_design`: new table `marketing_images` (data URL, alt, size, `source_id` for a refined copy). Campaign `templates` jsonb may carry `emailHeadline`, `emailCta`, `emailImage` (`/mi/{id}` or https) and `emailImageAlt`; older rows read them as blank.
  - The next free number is `core_0070`.
- **Mobile, please note:**
  - `GET /api/v1/me/loyalty` reads `loyaltyBalance`, which now also returns `type`, `visitsGoal` and `shopIds`. With `type = "transaction"`, `progressCents` is **visits** toward `visitsGoal` (not cents), and `remainingCents` is visits left. Please label the card "3 of 10 visits" in that case (`progressLabel` in `src/domain/loyalty.ts` does it). `rules.where` says where the program runs. No route or schema file under `/api/v1` changed.
  - Checkout through the client API (`finalizeSale`) now earns nothing and refuses a reward at an unassigned location ("Loyalty rewards aren't used at this location").
  - `importer.ts` still compiles and behaves the same: it uses `LoyaltyConfig`, `rewardExpiry`, `thresholdCents` and `rewardCents`, all unchanged. An imported Squire balance is cents (value based), which matches the current setup.
- **Public route:** `/mi/{id}` serves email images (public, immutable cache). Nothing else is new outside `/admin`.
- **Tests:** `tests/email-design.test.ts`, `tests/loyalty-program.test.ts`, `tests/db/loyalty-program.test.ts`, and additions to `tests/marketing.test.ts`, `tests/campaign-center.test.ts` and `tests/db/marketing.test.ts`.

### 2026-10-25: core (Rebook Rate report), nothing needed from mobile

- **What's new:** a Rebook Rate report by location and barber with the brand rollup (README, "Rebook rate"). It covers rebooked at checkout, return within 30/45/60 days or the client's own gap, future appointments, new-client rebook rate and 2nd-visit retention. It also appears in the Morning Dashboard (new `rebook` section, on by default), on a barber's Today page, as custom report fields and in the assistant.
- **Migration:** `core_0067_rebook_rate`, permissions only: `report.rebook_rate.view` and `report.rebook_rate.export` for roles that had `report.kpis.*`, plus view for Barber. No schema change. The next free number is `core_0068`.
- **No API change.** Nothing under `/api/v1` changed. A staff app could show the same per-barber numbers from `myRebook` in `src/server/rebook-report.ts`.
- **Tests:** `tests/rebook.test.ts` and `tests/db/rebook-report.test.ts`.

### 2026-10-25: core (staff milestones on the day), nothing needed from mobile

- **What's new:** milestones show in the admin on the day they happen, by first name (README, "Staff milestones", "On the day"). Banners on the shop's calendar, Sales and POS, confetti on the barber's calendar column, a congratulations window on clocking in and on Today, and a live toast for the shop when a count is reached at checkout.
- **No migration.** `brand_settings.milestones` gains `calendarBanner`, `posBanner`, `columnBadge`, `welcomeModal`, `liveToast` (all default true) and `allLocations` (default false). Older stored settings read with those defaults. Next migration number is still `core_0067`.
- **Checkout:** `finalizeSale` (shared with the client API's checkout) now records count milestones for the ticket's barbers right after a paid ticket, like the badge refresh. A failure there never fails the sale. No change to any `/api/v1` response.
- **Mobile, optional:** a staff app could show the same congratulations from the `staff_milestones` rows with `seen_at` null (the Today page uses `welcomeFor` in `src/server/milestones/day.ts`). Nothing in the customer app changes.

### 2026-10-25: core (staff milestones), one request for mobile

- **What's new:** staff milestones and celebrations (README, "Staff milestones"). That covers counts (cuts, clients served, new clients, rebooks, products sold), work anniversaries from a hire date, optional birthdays, personal bests and streaks. The brand edits the thresholds and adds its own. It includes a Morning Dashboard section, alerts to the brand and managers, a congratulations notice and trophy case for the person, an optional team shout-out feed with cheers, a report, and a brand-approved Campaign Center template for celebrating with clients.
- **Schema (`core_0066_staff_milestones`):**
  - `staff` gains `hire_date` (date), `birthday_month` and `birthday_day` (both or neither, never a year) and `milestones_shared` (boolean, default true).
  - New tables: `staff_milestone_rules`, `staff_milestone_baselines` (Squire totals per person and metric, as of a date), `staff_milestones` (each one once, by `dedupe_key`) and `staff_milestone_cheers`. `brand_settings.milestones` (jsonb) holds the settings.
  - `marketing_templates.purpose` (`milestone` or null). A template with a purpose is only offered from a milestone, never in the template library's picker.
  - `notification_jobs.kind` can be `milestone` (brand-level email, no `shop_id`); `notification_jobs_shop_present` now allows it.
  - Events `milestone.achieved` and `milestone.cheered` (category `milestone`).
  - Permissions `milestones.view`, `milestones.settings` (brand only), `report.milestones.view` and `report.milestones.export`.
- **Jobs:** `runMilestones` in `src/server/milestones/engine.ts`, hourly from `/api/cron/milestones` and `scripts/worker.ts`. It's idempotent.
- **Migration:** `core_0066_staff_milestones`. The next free number is `core_0067`.
- **Request:** see "Requests for the other agent". The importer could fill `staff.hire_date` and, optionally, Squire totals. Please don't return the new staff columns through `/api/v1`.
- **Tests:** `tests/milestones.test.ts` and `tests/db/milestones.test.ts`.

### 2026-10-25: core (Campaign Center v2), FYI for mobile

- **What's new:** a four-step blast wizard (quick update, promotion, or drafted by the assistant and reviewed by a person), repeating blasts, A/B tests with an automatic winner, holdout groups and lift, send-time optimization, an email open pixel, unique capped metrics with definitions, an attribution basis setting, revenue that leaves out clients already booked, a campaign calendar, a brand-approved template library, and coupon days and hours (README, "Campaign Center").
- **Schema (`core_0065_campaign_center_v2`):**
  - `marketing_campaigns` gains `campaign_type` (`update` | `promotion`, null on old rows: read it from `promo_id`), `recurrence`, `ab`, `holdout_pct`, `send_time_opt`, `template_id` and `ai_drafted`; a blast's review is recorded in the existing `reviewed_by` and `reviewed_at`. Blast `status` can now also be `paused` and `testing` (an A/B test waiting for its winner). Anything that lists blasts by status should expect both.
  - `marketing_sends.status` can be `holdout` (no message went, no job). It also gains `variant` (`a` | `b`), `opens`, `opened_at` and `already_booked`. Count sends with `status = 'queued'` as before.
  - New trigger keys `second_visit` and `post_visit` (switched off everywhere). If the app ever lists trigger keys, add them.
  - `promo_codes` gains `days_of_week` (0 = Sunday) and `time_from` / `time_to` (HH:MM, both or neither). Core checks them at checkout against the sale's time, and for a coupon held from booking against the appointment's time (when the hold is made and again at checkout). `checkBookingCoupon`, before a time is picked, doesn't check days or hours, so an app that shows a coupon early should expect the hold to refuse it for a time outside them.
  - New table `marketing_templates`.
- **Email opens:** marketing emails now have `notification_jobs.html_body` with a pixel at `/m/{token}/o.gif` (core route). Push opens aren't tracked yet. If the app reports push opens later, a core endpoint can set `marketing_sends.opened_at`; ask here.
- **Migration:** `core_0065_campaign_center_v2`. The next free number is `core_0066`.
- **Later the same day (admin only, nothing for the app):** fixes from a browser walkthrough. The assistant's keyword drafter no longer also requires a badge that names the stage it picked ("lapsed" had matched the Lapsed badge too). The wizard keeps its step after the first save, and the preview shows the chosen promo code. In the blasts list, the row actions sit under each name.
- **No request.** None of the mobile-owned files changed.
- **Tests:** `tests/campaign-center.test.ts` and the "Campaign Center v2" block in `tests/db/marketing.test.ts`.

### 2026-10-25: core (owner entities and franchising basics), FYI for mobile

- **What's new:** lightweight franchising basics only. Ray'z corporate still runs every location. Royalties, the ad fund, brand-standard locks, franchise agreements and client-data ownership rules are future work (README, "Owner entities and franchising basics").
- **Schema (`core_0064_owner_entities`):**
  - `owner_entities.is_default` marks **Ray'z Corporate**, the one default owner. `kind` is `brand` or `franchisee` again (checked). `shops.owner_entity_id` is now NOT NULL; an insert without one gets the default (trigger), so mobile inserts need no change.
  - New staff scope `entity` (`staff.shop_scope`) with `staff.scope_entity_id`. Its `staff_access_shops` rows are maintained by triggers, so anything that reads access by shop IDs keeps working. If the API ever lists or validates scopes, add `entity` (core: `SHOP_SCOPES` in `src/domain/permissions.ts`).
  - New role templates `franchisee_owner` and `franchisee_manager` (default scope `entity`). Template sort orders moved to 10 to 90.
  - New payments mode `entity`: the shop's card money settles to its owner's connected account (`entity_payment_accounts`). `chargeRoute` handles it, so app charges through core checkout need nothing. Any code that reads a shop's account to decide whether it takes cards should use `settlementAccount(shop)` from `src/server/payments/connect.ts` instead of `shopAccount(shopId)`; `chargeDestination` now takes `{ id, name, paymentsMode, ownerEntityId }`.
  - `shop_payouts.owner_entity_id`: an owner account's payouts have `shop_id` null and this set.
- **Core API:** `saveOwnerEntityAction` takes `kind` again (defaults to `brand`). New setup actions: `startEntityOnboardingAction`, `refreshEntityAccountAction`, `completeSimulatedEntityOnboardingAction`, `entityDashboardAction`. The location comparison takes `by=owner`.
- **Migration:** `core_0064_owner_entities`. The next free number is `core_0065`.
- **No request.** None of the mobile-owned files changed.
- **Tests:** `tests/db/owner-entities.test.ts` and `tests/owner-entities.test.ts`.

### 2026-10-25: core (franchising withdrawn; scale to 50+ locations), FYI for mobile

- **Franchising is withdrawn.** This build is for Ray'z corporate only. The franchising commits pushed earlier (owner groups, royalties, franchisee roles and scopes, brand standards) were reverted. Migration `core_0063_franchising` is gone and replaced by `core_0063_scale`. Any database that ran the old one should be reset (`pnpm db:reset`). Ignore the previous franchising FYI.
- **What's kept: scale readiness.**
  - Optional `regions` with nullable `shops.region_id`, managed on Location setup by people with every shop. Regions don't grant access; shop scoping stays `all`, `selected` and `one` through `staff_access_shops`.
  - `job_tasks`, a background queue claimed with `FOR UPDATE SKIP LOCKED` (`src/server/jobs.ts`). New cron `/api/cron/jobs` (rollups); `/api/cron/campaign-center` and `/api/cron/badges` now work through it, and so does `pnpm worker`.
  - `location_daily_stats`, per-location daily rollups (`src/server/rollups.ts`), and the Location comparison report (`report.rollup.view` and `.export`, granted wherever the KPIs report is).
  - A perf test at 50 locations, 500 staff and 500k clients (`pnpm test:perf`).
- **FYI, core API:**
  - `runMarketing(now, { triggers?: boolean })`: the cron passes `triggers: false` because triggers run per location from the job queue.
  - `runBadgeJob` takes an optional `bucket: { k, of }`.
  - `saveOwnerEntityAction` no longer takes a `kind`. Owner entities are corporate's LLCs (kind is always `brand`); `owner_entities` and the nullable `shops.owner_entity_id` stay as the hook for a later franchise layer.
  - The new audit actions are `region.create`, `region.update`, `region.delete` and `shop.region`.
- **Migration:** `core_0063_scale`. The next free number is `core_0064`.
- **No request.** None of the mobile-owned files changed.
- **Tests:** `tests/db/scale.test.ts`, `tests/regions.test.ts` and `tests/perf/scale.test.ts`.

### 2026-10-24: core (product history and refills), FYI for mobile

- **What changed.** The checkout product prompt and the client profile show the client's last product (name, date, location, quantity), their last 5 purchases, and a refill hint per product: has some left, likely running out (a week before it's due) or likely ran out. The hint comes from how long one unit lasts them (the median gap between purchase days divided by what they bought), or the product's typical interval when they bought it once. **Buy again** adds it in one tap at checkout. On the profile it puts it on the client's open ticket today, or a new retail ticket. The report builder gains a Products group (last product, date, location, quantity, refill status, products likely running out, next refill due). Segments gain `refillStatus` and `refillProductIds`.
- **FYI, core API:**
  - `TicketPrompts` gains `history` (`ProductHistory` from `src/domain/product-history.ts`). Each `ProductSuggestion` gains an optional `refill { status, due }`.
  - `SegmentSchema` gains `refillStatus` (`stocked` | `running_out` | `ran_out`) and `refillProductIds`. Both default to empty, so saved segments and anything the app sends parse as before.
  - `FilterOptions` gains `products`.
  - The new audit action is `sale.buy_again`.
- **No migration.** It reads paid tickets. The next free number is still `core_0063`.
- **No request.** A "running low?" card in the app could read `clientProductHistory(customerId, now)` from `src/server/product-history.ts` later. Nothing is needed now.
- **Tests:** `tests/product-history.test.ts` and `tests/db/product-history.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (checkout prompts), FYI for mobile

- **What changed.** The POS shows a rebook prompt (the next visit with the same barber at the client's interval, 2–3 times, one tap, families together, "Not now" with a reason and an optional reminder) and a product prompt (products tagged as used, the brand's service-product suggestions and past purchases, with stock, one tap to add). The brand switches each on or off per location, role and barber, and makes each skippable or required. **Reports → Checkout prompts** shows rebook rate and attach rate by barber and location. `prompt.shown`, `prompt.accepted` and `prompt.declined` go to the event log.
- **FYI, core API:**
  - `finalizeSale` (without a `handoffId`) and `startHandoff` refuse with `bad_request` "Answer the rebook prompt … before taking payment." while a required prompt is unanswered. Nothing in `/api/v1` pays tickets, so nothing changes there.
  - Appointments booked from the prompt use source `rebook` with `rebookedFromId`; a family's is a booking group with source `staff`.
  - The new notification kind is `rebook_reminder` (SMS/email only, from `/api/cron/notifications`). If the app lists a client's notifications, show it as "Rebook reminder".
- **Migration `core_0062_checkout_prompts`.** The next free number is `core_0063`.
- **No request.** A client-side "you're due" nudge in the app could read the same interval later; nothing is needed now.
- **Tests:** `tests/checkout-prompts.test.ts` and `tests/db/checkout-prompts.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (location profiles), FYI and REQUEST for mobile

- **What changed.** Each location has a profile, edited under Settings (Location profile, Photos and logo, Booking widget and links) and in the Add Location wizard: the street address with autocomplete (Google Places with `GOOGLE_MAPS_API_KEY`, the Census geocoder with `GEOCODER=census`, otherwise the ZIP's centre), a second line, the map pin and where it came from, the main phone as E.164, email, Google Place ID and review link, social links, parking and directions, amenities, photos and an uploaded logo, and the sales-tax jurisdiction (never public). Public `/locations` and `/locations/<slug>` pages carry HairSalon JSON-LD. Confirmations, reminders, receipts and calendar invites (`/a/<code>/calendar.ics`, `/g/<code>/calendar.ics`, and attached to confirmation and reschedule emails) now carry the full address and phone. The new merge fields are `{full_address}`, `{map_link}` and `{calendar_link}`.
- **FYI, core API:** `AppointmentMessageContext` gains optional `endsAt`, `shopFullAddress`, `shopGeo`, `shopDirections` and `services`. `getAppointmentByCode().shop` gains `textNumber`, `mapsUrl` and `locationUrl`, and `address` is now the full address. `saveShopInfoAction` no longer needs the address, phone or email. `LocationDraft` takes the profile fields, and `phone` is normalized to E.164.
- **Migrations:** `core_0060_location_profile` (shop columns and `shop_photos`) and `core_0061_place_id_check`. The second fixes 0060's Place ID check, which Postgres refused at write time because of its repetition count.
- **Request:** see "Requests" (mount the locations API under v1, `address2` on Shop, the `rayz://book` link).
- **Tests:** `tests/location-profile.test.ts` and `tests/db/location-profile.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (event log), FYI and optional REQUEST for mobile

- **What changed.** Every meaningful action is logged once in `analytics_events` by triggers: bookings, the online funnel, appointment flow, tickets, payments, tips, stock, staff time, messages, campaigns, badges, reviews, the assistant, calls, walk-ins and post-visit ratings. It's reportable in the report builder (Event log source), in Rayz Assistant (`event_report`), as an owner-only raw CSV and in a nightly Postgres warehouse copy. The new **Operations KPIs** report and the **Insights → Event log** page come with it.
- **FYI:** `safe()` now runs each action inside `withEventContext`, and `authorize()` stamps the staff member. `mergeCustomers` queues the merge for the warehouse. The new cron is `/api/cron/analytics` (09:20 UTC).
- **Migration `core_0059_analytics`.**
- **Request (optional):** see "Requests" (app funnel steps, app ratings, the device on app bookings, soft deletes).
- **Tests:** `tests/analytics.test.ts` and `tests/db/analytics.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (compensation fields), FYI and REQUEST for mobile

- **What changed.** Optional pay plans per employee, with an effective-dated history, and the brand's own employee fields. All off by default (see "Compensation fields" above and README, "Compensation fields"). The new pages are an employee's Compensation tab, **Payroll → Compensation**, **My pay**, and the Commission Payout report. When the brand says so, payroll takes hourly rates, commission (with per-service and per-category overrides and monthly tiers) and the guaranteed minimum from plans. The optional iSolved columns are added only when turned on.
- **FYI, core API:** `effectiveMethod` takes an optional fourth argument `planned`, and `draftPayouts` an optional `netCardFeeOf`. Existing callers are unchanged. `LineInput.guaranteeTopUp` and `Line.guaranteeTopUp` are new (0 for everyone with compensation off). `exportHeaders` and `exportRows` take optional `ExportOptions`, and `ShopBlock.exportFrom` records what each extra column carries.
- **Migration `core_0058_compensation`:** the tables above, `brand_settings.compensation`, and the six permissions added to Brand Admin.
- **Request:** see "Requests" (keep these tables out of `/api/v1`; an optional staff pay endpoint).
- **Tests:** `tests/compensation.test.ts` (unit) and `tests/db/compensation.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (company-wide client profiles), FYI and REQUEST for mobile

- **What changed.** Client profiles are brand-level (see "Company-wide clients" above and README, "Clients (brand-wide)"). Staff at any shop find and book any client by any part of their name or details. The client list shows every shop's clients, with home shop and shops visited as columns and filters (plus a `locations_visited` report field). Client-list exports keep to the exporter's shops' clients unless they work brand-wide. Shop logins don't see other shops' prices, tickets or spend on a profile. Same full name + birthday is now a "likely" duplicate. The Squire clients import merges the same client at several Squire shops by name and birthday, with uncertain pairs left for review.
- **FYI, API change in core:** `searchCustomers(term, limit, reach)` (no `scope` argument); `SearchScope`, `clientSearchScope`, `scopedSearchWhere` and `customerExactWhere` were removed. Nothing under `/api/v1` used them.
- **Request:** see "Requests" (staff client search through `searchClients`; shop logins and other shops' money; optional Birthday mapping in `importer.ts`).
- **Tests:** `tests/db/company-wide-clients.test.ts`; `tenant.test.ts`, `client-search.test.ts` and `clients.test.ts` updated for brand-wide lookup.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No migration, no new `ErrorCode`.

### 2026-10-24: core (client notes), FYI and REQUEST for mobile

- **What changed.** Client notes are brand-wide (see "Client notes" above and README, "Client notes"). They show on the client profile, the calendar block and appointment panel, the barber's Up next, walk-in check-in and checkout, and in the assistant's new `client_notes` tool.
- **FYI: `customers.notes` is now redacted by trigger.** A phone number or email written into it by any path, including `importer.ts` and `/api/v1`, is replaced with `[phone removed]` or `[email removed]`. Existing notes were redacted by the migration.
- **Request (when the staff app shows notes):** mount these under `/api/v1/staff`, each a one-line re-export plus `OPTIONS`, like the web routes under `src/app/api/staff/**`:
  - `GET /staff/clients/{id}/notes` → `getClientNotes`: `ClientNotesSchema` (`mode` full or count, `count`, `notes`, `canWrite`). 404 when they don't reach the client, 403 when notes are hidden for them. Each read is logged in `client_access_log`.
  - `POST /staff/clients/{id}/notes` → `postClientNote` (201): body `{ kind, body, pinned?, details?, appointmentId? }`, returns `{ note, removed }`, where `removed` lists `phone` or `email` if any were taken out.
  - `PATCH /staff/notes/{id}` → `patchNote` (body `{ body?, pinned?, details? }`) and `POST /staff/notes/{id}/remove` → `postRemoveNote`.

  The handlers resolve the staff member from the web session (`getStaffContext`). If the app's staff auth is a bearer token, call `listNotes`, `addNote`, `editNote` and `removeNote` from `src/server/client-notes.ts` with your `StaffContext` instead; they do every permission check.
- **Migration `core_0057_client_notes`.** New permissions `notes.view`, `notes.write`, `notes.edit_any` and `notes.private`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (combined checkout), FYI and REQUEST for mobile

- **What changed (web and server only).** Linked and family appointments check out on one combined ticket (see README, "Combined checkout"). Server: `src/server/combined-checkout.ts` (`sendToCheckout`, `sendGroupToCheckout`, `mergeTickets`, `splitOffTicket`, `splitTicketApart`, `openTickets`). `finalizeSale` in `checkout.ts` takes three new optional inputs:
  - `tenders`: split payment, each `{ method, amountCents, payerCustomerId?, payerLabel?, ... }`;
  - `tipByStaff`: per-barber tips;
  - `ticketPeople`: the appointment ids the screen showed. When it's given and someone was combined in or split off since, it fails with `conflict`.

  Existing callers are unaffected; `/api/v1` doesn't call any of these today.
- **Migration `core_0056_combined_checkout`:**
  - `appointments.checkout_ready_at` and `checkout_ready_by`;
  - `sales.merged_into_sale_id`: a ticket combined away is `voided` with it set;
  - `payments.payer_customer_id` and `payer_label` (40 characters, cleaned of anything like a card number);
  - `checkout_handoffs.tip_by_staff`;
  - the `sale_line_moves` view.

  If the app reads sales, please treat a voided sale with `merged_into_sale_id` as "moved to ticket #N" and not as a cancelled visit. Anything summing a barber's services from `sales.staff_id` should add `sale_line_moves`, the way `tip_split_moves` is added for tips.
- **Request (optional, when the app shows these):**
  - A barber's **Send to checkout** in the staff app: `POST /api/v1/staff/appointments/{id}/send-to-checkout` → `sendToCheckout(id, actor)`, returning `{ saleId, joined, ready, total, all }`. Permission: their own appointment, or `checkout.any`.
  - `checkoutReadyAt` on the staff appointment payloads, from `appointments.checkout_ready_at`.
  - On the client's receipt or visit history, `people` from `receiptData(saleId)` (lines grouped by person and barber, with `refundedQty`), and the payer in each tender's label (already in `receiptData`).
  - No new response field may carry a card or bank number: payer labels are names only, and `findSensitive` should keep passing.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (family booking groups), REQUEST for mobile

- **Please mount seven more family routes under `/api/v1/me/family`**, each a one-line re-export from `@/server/family-api` plus `OPTIONS`, like the web routes under `src/app/api/account/family/booking-options` and `booking-groups/**`:
  - `POST /me/family/booking-options` → `postGroupOptions`: the slot finder for one day. Body `{ shopId, date, people: [{ customerId, serviceId, addonIds?, staffId? }], after? }`, with 2 to 7 people (the parent and up to 6 children). Returns `{ plans: [{ plan, label, options, reason }], depositCents }`. The plans are `same_barber` (back to back), `together` (same time or overlapping, several barbers) and `earliest_finish` (mixed). Each option has `startsAt`, `endsAt`, `minutes` (the total window), `barbers` and `seats`.
  - `POST /me/family/booking-groups` → `postBookingGroup` (201): books the option picked, all or nothing. Body `{ shopId, people, plan, seats: [{ customerId, staffId, startsAt }] }`. It honors `Idempotency-Key`. When a seat was taken mid-checkout nothing is booked. For a named plan (not `custom`) the server first retries the same times with another barber for anyone who didn't ask for one. Otherwise it answers 409 `slot_unavailable` with `error.details.alternatives` (the same shape as booking-options). Please show those alternatives instead of a dead end.
  - `GET /me/family/booking-groups` → `listBookingGroups` (`{ groups }`, upcoming) and `GET /me/family/booking-groups/{code}` → `getBookingGroup`.
  - `POST /me/family/booking-groups/{code}/cancel` → `cancelBookingGroup`: everyone still booked, closing at the shop's cutoff before the first person's time.
  - `POST /me/family/booking-groups/{code}/options` → `postGroupRescheduleOptions` (body `{ date, after? }`) and `POST /me/family/booking-groups/{code}/reschedule` → `rescheduleBookingGroup` (body `{ plan, seats }`, all or nothing, 409 with alternatives).
  - `FAMILY_OPENAPI` in `src/domain/family.ts` already has the paths and the schemas (`GroupOptionsRequest`, `GroupOptions`, `GroupBookingRequest`, `GroupRescheduleRequest`, `BookingGroup`). If you spread it into `openapi.ts` they appear.
- **One set of messages for the group.** It gets one confirmation, one 24h and 2h reminder pair and one cancel or reschedule message. They go to the parent and sit on the first person's appointment, with the link `/g/{code}`. When that person is cancelled alone, the reminders move to the next one. Each member's `/a/{code}` still changes just that person. A group member's `appointments.group_id` is set, and `/api/v1/appointments/{code}` doesn't show it yet. Optional: add `groupCode` there (from `groupCodeOf` in `src/server/booking-groups.ts`) so the app can link to the group.
- **Deposits are taken at the desk for now.** When the brand sets `groupDepositCents`, a group of at least `groupDepositFrom` people is created with deposit `due`. Staff take it on a ticket, and it's held as credit (a gift card with source `deposit`). It's applied at checkout and kept on a whole-group no-show or late cancel when `groupNoShowForfeit` is on. Taking it online needs your saved-card flow. When that exists, tell us and we'll add a hook that marks it `held` from a PaymentIntent.
- **`POST /me/family/bookings` is unchanged for callers.** It now books through a group (plan `custom`) for two or more people, so those bookings also get one confirmation and a `/g/{code}` link.
- **Migration `core_0055_booking_groups`:** the `booking_groups` table and `appointments.group_id`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`. `src/lib/api-client.ts` (web) now keeps `error.details` on `ApiError`.

### 2026-10-24: core (family booking flow), FYI and REQUEST for mobile

- **Online booking confirms the phone before showing the family.** `/book` no longer shows a family to a guest who only typed a phone. It calls your `/api/v1/auth/otp/start`, `/verify` and `/complete` as they are (read-only, no changes asked), saves the tokens with `setTokens`, and only then reads `/me` and `/api/account/family`. For a new account (`isNew`) it then sends `PATCH /me` with the email and the consents the guest ticked. A guest can still book without a code, just for themselves (the old guest form); that path shows nothing about the account.
- **Request:** please give the app the same order: verify the code first, then list the parent and their children from `/me/family` (first names, ages), with multi-select for who the appointment is for and an inline Add a child (`POST /me/family/children`). A booking for several people goes through `POST /me/family/bookings`. The pure selection rule is `togglePartyMember` in `src/domain/family.ts`: the first person picked takes the chosen time, removing them moves the next one up, the last person stays, and the cap is `FAMILY_BOOKING_MAX`.
- **Staff lookups** group results by family (`groupFamilies` in `src/domain/client-search.ts`). `findClients` no longer drops a matched child's parent at the result limit, so a search can return up to twice the limit when children match. Nothing in `/api/v1` calls it.

### 2026-10-24: core (family accounts), REQUEST for mobile

- **Please mount the family endpoints under `/api/v1/me/family`.** Each is a one-line route file re-exporting from `@/server/family-api`, the same as the core web routes under `src/app/api/account/family/`:
  - `GET /me/family` → `getFamily`;
  - `POST /me/family/children` → `postChild` (201);
  - `PATCH /me/family/children/{id}` → `patchChild`;
  - `POST /me/family/children/{id}/remove` → `removeChild`;
  - `POST /me/family/children/{id}/split` → `splitChildAccount`;
  - `POST /me/family/bookings` → `postFamilyBooking` (201, `{ appointments }`; source `api` unless the request sends `x-client: web`).
  - Every file also exports `OPTIONS`. The handlers call `requireCustomer`, and a child's token gets 403: the parent manages children.
- **And document them in `openapi.ts`:** `import { FAMILY_OPENAPI } from "@/domain/family"`. Spread `.components` (`Family`, `FamilyMember`, `ChildInput`, `FamilyBookingRequest`, `FamilySplitRequest`) and `.paths`. The fragment uses your `bearerAuth` and `Error` names.
- **Until then**, the web account page reads `/api/account/family/...` with the same bearer token. The app can use those paths too.
- **Children have no login or contact details.** A child is a `customers` row with `guardian_id` set (one level only). The `customers_family_guard` trigger clears a child's phone, email and opt-ins on every write, so please don't offer sign-in, OTP or consent capture for a child. Messages for a child go to the parent through `src/server/household-contact.ts` (`contactFor`, `householdContact`).
- **`loyaltyBalance(customerId)`** now resolves the household card: for a child in household mode (the default), it returns the parent's balance with `household: true` and `ownerId`. Consider showing "Family card" when `household` is true.
- **`/me/appointments`** is unchanged and lists only the signed-in person's own appointments. The children's upcoming appointments are in `GET /me/family` (`children[].upcoming`).
- **Squire import:** family links are a post-step in `src/server/family-import.ts` (`importFamilies`), called from the core import action after a clients file. It reads `mapHeaders` and `parseSquireDateTime` from `importer.ts` read-only. `importer.ts` isn't changed.
- **Migration `core_0054_family_accounts`:**
  - `customers.guardian_id`, `birth_year`, `former_guardian_id`, `own_account_at`;
  - the `sale_appointments` table and `sale_items.appointment_id`;
  - `brand_settings.family` jsonb (`maxChildren` 6, `loyalty` `household`/`individual`, `splitAge` 13);
  - the `clients.family` permission.
- **Server-only:** `src/server/family.ts` and `family-ticket.ts` don't import `server-only`, because checkout and refunds load them outside Next (the worker, scripts). They load the badge and cadence modules lazily.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (customer badges), REQUEST for mobile

- **Please mount `GET /api/v1/me/badges`.** It's one file: `src/app/api/v1/me/badges/route.ts` with `export { GET, OPTIONS } from "@/server/customer-badges-api";`.
  - The handler calls `requireCustomer` and returns `customerBadges(id)`: `{ badges: [{ id, name, icon, tone, color, earnedOn, text, action }], progress: [{ badge, name, icon, tone, color, current, target, remaining, text }] }`.
  - `action` is `{ label: "Book now", url }` on We miss you, otherwise null.
- **And document it in `openapi.ts`:** `import { CUSTOMER_BADGES_OPENAPI } from "@/domain/customer-badges"`. Spread `.components` into `components` and `.paths` into `paths`. The fragment uses your `bearerAuth` and `Error` names.
- **Until then**, the web account page and booking site read the same handler at `/api/account/badges` (core-owned, same bearer token). The app can use that path too.
- **Only customer-visible badges** come back, in customer wording: the brand's setting over the catalog default. Staff judgments (Low rating, How they found us, No product yet, custom badges on ratings) never do. Draw `icon` from the badge icon names (`src/components/badge-icons.tsx` has the paths); `color` is a hex.
- **Migration `core_0053_customer_badges`:**
  - `client_badges.since` and `.progress` (jsonb);
  - the `client_badge_notices` table;
  - the custom badge tone check gains `orange`.
- **Badge news:** a new manual Campaign Center trigger `badge_news`. Its messages go through `deliver`, so they use your marketing consent columns read-only, like every campaign.
- **Booking:** `createAppointment`, `cancelAppointment` and `setAppointmentStatus` (cancelled, no-show, booked) recompute the client's badges. They load `./badges` lazily, so the client API's import graph is unchanged, and a failure never fails the booking.
- **`api-client.ts`:** `api()` takes an optional `base` (default `/api/v1`).
- **Worker:** `pnpm worker` preloads `scripts/allow-server-only.cjs`, which resolves `server-only` to an empty module outside Next. Before this change it already crashed on `server-only`, through `marketing/audiences`, then `client-filters`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`.

### 2026-10-24: core (client badges)

- **Badges:** `src/domain/badges.ts` (pure, client-safe: catalog, `BadgeSettingsSchema`, `deriveBadges`, `visibleBadges`, `showBadges`) and `src/server/badges.ts` (facts, cache, `refreshBadges`, `runBadgeJob`, `shownBadges`, `badgeCounts`). The settings loader is `src/server/badge-settings.ts`.
- **Migration `core_0052_client_badges`:**
  - `brand_settings.badges` jsonb;
  - `custom_badges` (scrub trigger on `label` and `tooltip`);
  - `client_badges` (`customer_id` PK cascade, `keys text[]` GIN, `badges jsonb`, `hash`, `computed_on`);
  - grants `badges.settings` to `brand_admin`.
- **Cron:** `/api/cron/badges` (in `vercel.json`, `CRON_SECRET`).
- **Checkout:** `finalizeSale` refreshes the client's badges after the sale, loading `./badges` lazily. The client API's import graph is unchanged, and a failure never fails the sale.
- **Where:** `ClientPolicy` gains `badges` and `customBadges`. Display covers `ClientHit.badges`, `CalAppt.badges`, the POS customer, the profile, the client list, Today and `TodayBlock.clients` in the Morning Dashboard. Filters: `SegmentSchema.badges`, the report builder field `badges`.
- **For the app (optional):** if you want badges in the staff app, read them through `shownBadges(policy, ids)`, so the brand's on/off, role and data-level rules apply. Never return raw `client_badges` rows. For customers, use `GET /me/badges` (see the customer badges entry).
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`, and consent columns are only read.

### 2026-10-24: core (time between visits)

- **Cadence:** `src/domain/visit-cadence.ts` (pure, client-safe) and `src/server/visit-cadence.ts`. Visit days are distinct America/Chicago dates of completed appointments; the cadence is the median of the last 10 gaps (`CADENCE_GAPS`), null under two visit days. Status: `on_track` (booked, or more than `DUE_LEAD_DAYS` = 3 before the next expected visit), `due` (until `max(7, 25%)` past it), `overdue`. `cadenceCtes(name, cond, now)` is the SQL twin (`percentile_cont(0.5)`, `round(numeric)` for the next day); `cadenceFor(ids, now)` takes one `uuid[]` parameter; `clientCadence(customerId, now)` gives the profile's card and per-barber rows.
- **Where:** profile card, `/account` (from `/me/appointments`), client list column and CSV export, `SegmentSchema.visitStatus` (new) with `minAvgGapDays`/`maxAvgGapDays` now reading the median, report builder fields `cadence_label`, `days_since_visit`, `next_visit_due`, `visit_status` (`avg_gap_days` now the median; CTE `cd` scoped like `va`), assistant `customer_report` args `visitStatus`, `minDaysBetweenVisits`, `maxDaysBetweenVisits`.
- **Rebook:** `rebookReminderDue` now takes the cadence and two visit days (was three and the plain average); the Campaign Center reminder fires at cadence less `leadDays`. `rebookDue`/`dueForCut` take an optional `cadenceDays`, which Today's lists pass.
- No migration. Tests: `tests/visit-cadence.test.ts`, `tests/db/visit-cadence.test.ts`; `tests/marketing.test.ts` now expects two visits to be enough.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`. No new `ErrorCode`. See the request above for `/me`.

### 2026-10-24: core (contact access grants and brand portal users)

- **Contact access grants:** table `client_contact_grants` (kind `full_contact` | `export`, `staff_id` xor `shop_id`, optional `expires_at`, revoked rows kept). `src/server/contact-grants.ts` and `src/domain/contact-grants.ts`; applied in `accessFor` after the `BRAND_LEVEL_ONLY` and `SHOP_LOGIN_NEVER` strips. `full_contact` adds `clients.contact_full` (in `GRANT_ONLY`: no role or override can hold it, and the editors hide it). `export` adds `clients.export`, each `CLIENT_LIST_REPORTS` export whose view is held, and `campaign_center.export` with its view. `StaffAccess.granted` lists them, and `grantor` leaves them out, so a grant is never the holder's to give on. `seesFullContact` and `clientListDenied` honour them. Page `/admin/client-data/contact-access`; audit actions `client_contact.grant` and `client_contact.revoke`.
- **Users:** `/admin/users` and `/admin/users/[id]` (`permissions.manage`), sign-up at `/invite/[token]`. `src/server/users.ts`, rules in `src/domain/users.ts` (`accountChangeDenied`: self, the last owner who can sign in, `staffEditDenied`, upcoming bookings). Invites in `staff_invites` (SHA-256 token hash, 7 days, single use) sent with `sendNow` kind `staff_invite`; the outbox keeps the body with the link removed. Remove is a soft delete (`staff.removed_at`; email, password, authenticator and PIN cleared, invites and grants ended). Remote access is the `access.remote` override through `saveUserAccessAction`. The person access editor moved to `src/app/admin/permissions/people/[id]/access-section.tsx` and is shared with the user page.
- **Two-step sign-in:** `src/lib/totp.ts` (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step; replay refused through `staff.totp_last_step`; 5 failures lock for 15 minutes) and `src/lib/secret-box.ts` (AES-256-GCM from `AUTH_SECRET`) in `src/server/auth/two-factor.ts`. Login is password, then the code (or enrolment, through a `login_2fa` ticket), then the network check. New columns on `staff`: `two_factor_required`, `totp_secret`, `totp_enabled_at`, `totp_last_step`, `totp_failures`, `totp_locked_until`, `invited_at`, `removed_at`. Audit actions `user.*`.
- Migration `core_0051_user_admin` (also widens `notification_jobs_shop_present` for `staff_invite`, `NOT VALID` like the others). Tests: `tests/contact-grants.test.ts`, `tests/db/contact-grants.test.ts`, `tests/users.test.ts`, `tests/db/users.test.ts`; the lockdown and privacy tests now expect the new refusal messages.
- **For the mobile agent:** `/api/v1` has no staff sign-in today. If one is added, it needs the two-step code for anyone with `totp_enabled_at` or `two_factor_required`, and must refuse rows with `removed_at` (as `verifyPassword` does).
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`; consent columns are only read. No new `ErrorCode`.

### 2026-10-24: core (client contact lockdown)

- **Brand-level roles:** `roles.brand_level` (custom roles only, set by the Brand Owner). `isBrandLevelRole` (Brand Owner, Brand Admin, or a custom role with `brand_level`; built-in shop and staff templates never) and `isBrandLevelPerson` (a person, not a shop login, in one with scope "all") in `src/domain/permissions.ts`.
- **`BRAND_LEVEL_ONLY`:** `clients.export`, `campaign_center.export`, `import.run`, `clients.privacy` and `report.client_ratings.export` (`CLIENT_LIST_REPORTS`). Stripped by `effectiveAccess` for roles that aren't brand-level, part of `BRAND_ONLY` and `SHOP_LOGIN_NEVER`, taken off the shop and staff templates, and refused by `roleChangeDenied` and `userAccessChangeDenied` (which takes `next.brandLevel`).
- **Contact ceiling:** `CONTACT_FIELDS` and `contactCeiling` in `src/domain/client-privacy.ts`; `makePolicy({ fullContact })` caps phone, email and address at masked, and `ClientPolicy` gains `fullContact` and `mayReveal(f)`. `seesFullContact(ctx)` and `clientListDenied(ctx)` in `src/server/client-privacy.ts`. `fieldRuleChangeDenied` takes `rule.fullContact`. `SHOP_LOGIN_CAPS` is `masked` | `hidden`; a stored `role` reads as `masked`.
- **Guarded:** `revealClientFieldAction` (contact fields), the customers, Campaign Center, ratings, import skipped-rows and access-log downloads, `exportDenied` for customer custom reports (page, download, scheduled attachment), and the audit log CSV (client entries dropped).
- Fixed: `saveRoleAction` dropped `clients.export` (and any `.export` without a `.view` twin); the view-before-export filter now applies to report permissions only.
- Migration `core_0050_brand_level` (column, and the data updates taking the client-list permissions off shop and staff roles). Tests: `tests/client-contact-lockdown.test.ts`, `tests/db/client-contact-lockdown.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`; consent columns are only read. No new `ErrorCode`.

### 2026-10-24: core (shop login parity with Squire)

- **Shop Login role** (`shop_login` in `ROLE_TEMPLATES`) for new shop logins, and hard caps for every `staff.kind = 'shop'` login: `SHOP_LOGIN_NEVER` / `sharedLoginAccess` in `src/domain/permissions.ts`, applied in `accessFor` (`src/server/auth/access.ts`). Client contact for shop logins is capped by `brand_settings.shop_login.clientContact` (`masked` | `hidden`, default `masked`; `role` was removed by the client contact lockdown) in `clientPolicy`; `saveShopLoginCapAction` on Client data protection.
- **Staff contact:** permission `staff.contact`; `seesStaffContact` / `staffContact` in `src/domain/staff-contact.ts`. `saveProfileAction` keeps email and phone when the editor can't see them.
- **Manager approval:** `src/server/manager-approval.ts` (`needsManager`, `approvers`, `approvedActor`, using the time clock PIN and its lockout). `Actor.approvedBy` is written to `refunds.approved_by`, `sales.void_approved_by`, `sale_reassignments.approved_by` and the audit details. Sales actions take an optional `approval`.
- **Reassign:** `reassignSale` in `src/server/reassign.ts`, permission `sales.reassign`. Unpaid `tip_ledger` rows are deleted and re-synced for the new barber (the ledger guard allows deleting unpaid rows and nothing else); paid ones get an `adjust` row.
- **Drawer:** `shops.drawer_opening_cents`, `cash_drawers.opened_by/opened_at`, `cash_drawer_moves` (`paid_in` | `paid_out`). `src/domain/drawer.ts` (`drawerTimeline`) and `src/server/drawer.ts`. `closeDrawer` uses the counted opening and adds the moves.
- **Shop settings per part:** `settings.shop_details`, `_hours`, `_booking`, `_checkout`, `_phone`; `SHOP_SETTING_FIELDS`, `shopSettingsDenied`, `editableShopParts`. `settings.shop` still means every part.
- **Phone operator:** `shops.phone_operator` (jsonb), `call_logs.operator` and `operator_choice`; `src/domain/phone-operator.ts`, `handleOperatorChoice` in `src/server/shop-line.ts`, route `/api/twilio/voice/operator`. Attribution: first booking by the same phone at the same shop within 7 days.
- **Reports:** `end_of_day`, `leaderboard`, `sales_tax`, `retention`, `acquisition`, `phone_operator` in `src/server/shop-reports.ts`; `ReportData.options` (chip rows carried in links and CSV); `grainsFor` moved to `report-sql.ts`; presets `quarter` and `lastquarter`; `priorPeriod`; saved shortcuts in `src/domain/report-shortcuts.ts`; `brand_settings.tax_filing` with `src/domain/sales-tax.ts`. `NO_BARBER_REPORTS` in `src/app/admin/reports/scope.ts` lists the reports without a barber filter.
- Migration `core_0049_shop_login`. Tests: `tests/shop-login.test.ts`, `tests/db/shop-login.test.ts`; the migration-seed test now reads roles inserted by later migrations.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`; consent columns are only read. No new `ErrorCode`.

### 2026-10-24: core (Rayz Assistant)

- **Rayz Assistant:** a chat panel (`src/app/admin/assistant/panel.tsx`) in the admin layout for anyone whose role has it on, plus a settings page at `/admin/assistant/settings` (Setup). Server actions are in `src/app/admin/assistant/actions.ts`; the run loop, drafts, limits and settings are in `src/server/assistant/index.ts`.
- **Tools** (`src/server/assistant/tools.ts`): `run_report` (over `REPORT_LOADERS` via `resolveScope`; the enum is the person's viewable reports minus `audit_log`, `client_ratings` and `morning_dashboard`), `customer_report` (the report builder's `runReport`; fields limited to `fieldUse` "full" and never contact, birthday or custom fields), `builder_report` (the same `runReport` over the sales, appointments, staff, inventory, tips and campaigns sources; a source only when `sourceReport` passes, fields limited to `fieldUse` "full"), `help` (`src/domain/assistant-help.ts`, filtered by `pageAllowed`), `draft_po` (`suggestionsFor`, then `createPos` on confirm) and `draft_blast` (`saveBlast` on confirm, draft only). Location and barber names are matched only against the person's shops, location groups and `barbersAt(ctx.shopIds)`.
- **Providers** (`src/server/assistant/providers.ts`): OpenAI chat completions (`store: false`), Anthropic messages, and a keyword stub. Chosen by `ASSISTANT_PROVIDER`, else whichever key is set, else the stub outside production. `ASSISTANT_MODEL` overrides the model. No user id is sent, and errors log the status only.
- **Builder links:** `encodeDefinition` / `decodeDefinition` in `src/domain/report-builder.ts`; `/admin/reports/custom/new?d=<definition>` opens the builder with it.
- Permission `assistant.settings` (Settings and data, brand-only). Settings live in `brand_settings.assistant`: `enabled`, `roles` (role id → false to turn off; missing means on), `perMinute`, `perDay`, `actions`. Audit actions `assistant.question`, `assistant.tool`, `assistant.rate_limited`, `assistant.action_confirmed`, `assistant.action_cancelled`, `assistant.action_failed`, `settings.assistant`.
- Migration `core_0048_assistant`: `brand_settings.assistant`, `assistant_conversations`, `assistant_messages`, `assistant_actions` (with `scrub_sensitive_row` triggers on their free text), and the permission for Brand Admin.
- Tests: `tests/assistant.test.ts`, `tests/db/assistant.test.ts`.
- Also: the Today page's **Up next** table scrolls inside its card instead of widening the page on phones.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`; consent columns are only read.

### 2026-10-24: core (custom report builder)

- **Custom reports** under Reports (`/admin/reports/custom`, `/new`, `/[id]`): a builder over a whitelisted field list (`src/domain/report-builder.ts`), run by `src/server/report-builder/engine.ts`, which puts the query together from one SQL fragment per field with every value bound. Customers is the only source built; sales, appointments, staff, inventory, tips and campaigns are listed in `REPORT_SOURCES` and allowed by the table's check, so adding one needs no migration.
- **Saved reports** (`saved_reports`): definition (jsonb of field keys, filter segment, sort, grouping, totals, dates, location and barber tokens), visibility `private` / `roles` / `template`, `role_ids`, `schedule` (jsonb) and `morning`. `saved_report_sends` (report, staff, period) claims each scheduled send.
- **Scheduled sends** run from the notifications cron (`sendDueReports` in `src/server/report-builder/deliver.ts`) as `notification_jobs` kind `saved_report`, brand-level (no `shop_id`; `notification_jobs_shop_present` now allows it, `NOT VALID` like the others), with the file removed once sent. `/admin/notifications/[id]/attachment` returns 404 for that kind.
- **Morning Dashboard:** `MorningDashboard.savedReports` holds the totals of reports marked for it, for each person's broadest version only. `morningDoc` adds a `saved_reports` section.
- **Blasts:** `/admin/campaign-center/blasts/new?f=<filter>&shops=<ids>` fills in a new blast's filter and locations; `shops` is checked against the person's locations.
- Permissions `report_builder.view`, `report_builder.build`, `report_builder.export` (group "Custom reports"; always on for Brand Admin except export). Exporting a customer report also needs `clients.export`. Audit actions `report_builder.create`, `update`, `duplicate`, `delete`, `export`; exports and previews showing protected details go in the client data access log.
- Migration `core_0047_report_builder`: the two tables, indexes `sales_customer_date_idx`, `appointments_customer_status_idx`, `customers_created_at_idx`, `customers_preferred_staff_idx`, the outbox check, and the permissions for Brand Admin, Regional Manager and Shop Manager.
- Tests: `tests/report-builder.test.ts`, `tests/db/report-builder.test.ts`; `tests/db/tenant.test.ts` (another shop's private report), `tests/tenant-guard.test.ts`, `tests/ratings.test.ts` (the engine reads ratings only for the rating column).
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`; consent columns are only read.

### 2026-10-24: core (Morning Dashboard)

- **The morning digest is now the Morning Dashboard:** a page at `/admin/morning` (Insights) and an email built from the same data. `src/server/digest.ts` and `src/domain/digest.ts` are gone; `src/server/morning-dashboard.ts` builds it and `src/domain/morning-render.ts` lays it out once for the page, the HTML and text email, the PDF and the SMS line. Settings stay in `brand_settings.digest` (old settings carry over) and are edited at `/admin/digest`.
- **Content:** the last open day (Monday covers Saturday) against the same weekday last week, plus week to date against the same days last week: sales, clients and bookings, utilization and cut times, loyalty and gift cards, Campaign Center results, review link clicks, today's schedule and open time, and exceptions (punches, overtime risk over 40 or a part-timer over 32, low stock, purchase orders, tip payouts, approvals, Stripe payouts). Each section is gated by the matching report permission per shop.
- **Recipients and versions:** by role (main or per-shop) plus include/exclude, and only people with the new report `report.morning_dashboard.view` at a live or temporarily closed shop. Several shops get the all-locations version by default; per person the brand can pick one per shop or both (`versions` in the settings).
- **Sending:** `/api/cron/morning-dashboard` every minute 09:00–17:59 UTC, plus the notifications cron as a fallback; default 7:02 AM, nothing after noon. Each person, version and channel is claimed in `morning_dashboard_sends` first, so runs never double-send; stale claims are taken over after 10 minutes. Jobs are kind `digest` with the new `notification_jobs.html_body` (scrubbed by the same trigger as `body`) and an optional PDF attachment; an optional SMS line goes to recipients with a phone. `EmailProvider.sendEmail` takes an optional `html` argument.
- `ratingsGivenAt` moved from `src/server/reports.ts` to `src/server/ratings-report.ts`, so the cron's import graph never reaches the ratings table. `tests/ratings.test.ts`'s walker now ignores `import type` lines, which load nothing.
- Migration `core_0046_morning_dashboard`: `html_body`, the scrub trigger on it, `morning_dashboard_sends`, and the report for Brand Admin, Regional Manager and Shop Manager.
- Tests: `tests/morning-dashboard.test.ts`, `tests/db/morning-dashboard.test.ts`; the digest cases left `tests/today.test.ts` and `tests/db/today.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`; consent columns are only read.

### 2026-10-24: core (Campaign Center permissions and We have openings)

- **Locations get one Campaign Center action by default: We have openings** (`campaign_center.openings`). Coupons (`promos.manage`), campaigns, segments, blasts, exports, own lapsed clients and the marketing reports are brand-only unless the brand grants them in the role editor or per person. Migration `core_0045_openings` takes them out of the Regional and Shop Manager roles and gives those roles, Front Desk and shop logins We have openings and `report.openings`.
- **We have openings:** a location picks barbers and today or tomorrow (or up to 3 of the next 7 days). For each barber it pulls their real open times from `getAvailability`, and texts or emails the barber's regulars and recent clients who agreed to marketing and have nothing booked, through the engine (consent, unsubscribes, quiet hours, caps). The brand sets a per-client window (one openings message per 7 days by default), per-location daily and weekly send limits, optional approval, and the wording. Counts only; no names or contacts are shown or exported.
- **Live page:** the link goes to `/book/{shop}/openings/{id}`, the barber's open times refreshed every 15 seconds, then **All booked, join the waitlist** (`openings_waitlist`, separate from walk-in `waitlist_entries`). A time opens `/book/{shop}?service=&barber=&start=<ISO>`, which lands on the details step with that time; a taken time still fails with `slot_unavailable` as before. If the app ever opens these links, the same `start` parameter works.
- New: `marketing_campaigns.kind` `openings` and statuses `pending_approval`, `rejected`, `expired` (checks widened); `reviewed_by`, `reviewed_at`, `review_note` (scrubbed); table `openings_waitlist`. Settings live under `brand_settings.marketing.openings`.
- Tests: `tests/openings.test.ts`, `tests/permissions.test.ts`, `tests/db/openings.test.ts`; `tests/db/marketing.test.ts` and `tests/db/tenant.test.ts` grant the Campaign Center where a brand would.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`; consent columns are only read.

### 2026-10-24: core (client search, filters and duplicates)

- **Search** everywhere in the brand portal (client list, sidebar **Find a client**, calendar, POS, walk-ins): names in any order with typos and nicknames, phone in any format or last 4, email, client ID or number, loyalty card, gift card, coupon, ticket, appointment code, Squire ID, birthday, address, zip, town, notes and tags. A hidden detail is matched only on its exact whole value through a SHA-256 lookup hash (`customers.phone_hash`, `email_hash`, `birthday_hash`, `address_hash`, kept by a trigger).
- **Loyalty card for the app:** `RAYZ1-<customers.number>-<10 base32 characters>`. The signature is HMAC-SHA256 with `AUTH_SECRET` over `loyalty-card:<customer id>:<number>`, first 50 bits in RFC 4648 base32. `src/server/loyalty-card.ts` has `loyaltyCardValue`. **Request to the mobile agent:** if the app shows a card, show this value as a QR (error correction M), and don't invent another format, since the desk's scanner types it into the search. An endpoint that returns it would need `/api/v1`, which core doesn't touch.
- **Filters** (one `SegmentSchema` for the client list and Campaign Center): visit history, barbers and locations, spend and tips, loyalty, gift cards and coupons, profile (rating, tags, birthday, age, zip, city, distance, source, referral, created), messaging (consent per channel, review clicks, campaigns received and clicked) and filled-in or empty checks. Marketing consent is read through `consentColumns()` as before; missing columns mean nobody matches.
- **Duplicates** for Squire imports: scored pairs, "not the same person" (`customer_duplicate_dismissals`), bulk merge. Merges now repoint every foreign key to `customers` found in `pg_constraint`, so a customer-app table that references a client moves with a merge instead of cascading away. A new table with a unique key on `customer_id` makes merges fail until it's handled in `mergeCustomers`.
- **Brand Admins always see every client detail** at full; field rules for them are refused.
- New columns on `customers`: `number`, `nickname`, `source`, `referred_by_id`, and generated `search_name`, `address_zip`, `address_city`. Tables `client_photos`, `saved_client_searches`, `customer_duplicate_dismissals`, `zip_points`. Permissions `clients.filters`, `clients.saved_searches`. Migration `core_0044_client_search`.
- Tests: `tests/client-search.test.ts`, `tests/db/client-search.test.ts`, `tests/db/client-privacy.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, and no consent columns were written or migrated.

### 2026-10-23: core (lapsed clients in the Campaign Center)

- **Segment builder:** last visit more than 2 / 3 / 4 / 5 / 6 / 8 / 12 weeks ago, between two points (weeks or days) or custom days, "nothing booked since", and barbers by the client's primary barber (preferred, else last), most recent barber or any visit. The opted-in count updates live.
- **Lapsed sequences:** several steps per campaign (2 weeks reminder, 3 weeks with the booking link, 4 weeks coupon, 6+ weeks bigger coupon by default), each with its own wording and coupon. A client gets the step for how long it's been, once per lapse, and leaves on booking. Per location and barber, each message signed by the client's barber with a link to book with them. "We miss you" and win-back skip clients a sequence already wrote to.
- **My lapsed clients:** with **Campaign Center: own lapsed clients**, a barber sees their own lapsed clients (first name and last initial, never phone or email) and sends **From your barber** through the engine. Per-location switch, daily limit, audited.
- **Report:** **Lapsed clients by barber** (`report.lapsed_clients`): week buckets, lapsed messages, clients messaged, rebooked and rebook rate, by barber and by campaign and step.
- Migration `core_0043_lapsed_campaigns` (see "Campaign Center"). If the app ever sends a booking link from a sequence, `?barber={slug}` on `/book/{shop}` picks the barber, as before.
- Tests: `tests/marketing.test.ts`, `tests/db/marketing.test.ts`, `tests/db/tenant.test.ts` (another shop's sequence page and actions).
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, and no consent columns were written or migrated.

### 2026-10-23: core (Marketing renamed to the Campaign Center)

- Nav **Campaign Center → Campaigns, Blasts, Settings**; pages under `/admin/campaign-center`, the report **Campaign Center** at `/admin/reports/campaign-center`, and the cron at `/api/cron/campaign-center` (`vercel.json`). The old routes never shipped, so there are no redirects.
- Permissions **Campaign Center: view / create / send / export** (`campaign_center.*`) and `report.campaign_center.*`. Create and send are now separate: create writes and drafts (brand-level with access to all shops), send switches campaigns and sends, schedules or cancels blasts. Migration `core_0042_campaign_center` renames the old keys in roles and per-person overrides. If the app ever checks staff permissions, use the new names.
- Audit actions renamed to `campaign_center.*` and `brand.campaign_center_settings`.
- Tests: `tests/db/marketing.test.ts` (create and send apart, brand-wide create, the rename migration), `tests/permissions.test.ts` (templates replayed through the rename).
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, and no consent columns were written or migrated.

### 2026-10-23: core (Marketing / Engage)

- **Coupons:**
  - Percent, dollars or a free item, with targets, locations, minimum spend, dates, total and per-client limits, shared or single-use codes, first visit only, stacking and auto-apply.
  - Redeemed in POS checkout (held from online booking, or applied automatically) and reversed on refund or void.
  - They lower loyalty's net service spend.
- **Campaigns:** ten automated campaigns, switched on and worded per location, and blasts with a segment builder, preview, test send, schedule or send now.
- **Engine:** consent from PR #8's columns only, STOP, HELP and unsubscribe, quiet hours (9 PM to 9 AM local), weekly and monthly caps, and idempotent sends on a 15-minute cron.
- **Reporting:** a report by campaign, location and barber, and a contact export behind `marketing.export` (now **Campaign Center: export**).
- Migration `core_0041_marketing`. Tests: `tests/coupons.test.ts`, `tests/marketing.test.ts`, `tests/db/marketing.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts` (only imported, to read a signed-in customer for booking drafts), `importer.ts`, and no consent columns were written or migrated.

### 2026-10-23: core (when the Google review link is shown)

- **Leave a review** and the follow-up only from the client's 3rd completed visit, counted across all locations (brand setting, overridable per location), and not again at a location for 90 days (configurable) after the client taps its link. Visit count and taps only, no rating gating.
- Migration `core_0040_review_visits`: `brand_settings.reviews`, and skip reasons `few_visits` and `snoozed`. Tests in `tests/reviews.test.ts` and `tests/db/google-reviews.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, and no consent columns were written.

### 2026-10-23: core (Google reviews)

- Each location's Google review link (Shop settings → Receipts and the setup wizard): a `g.page/r/…` link, a write-review link or a Place ID, saved as the write-review URL. No link, no **Leave a review** button.
- Clicks counted per location and barber through `/receipt/{token}/review` (previews and scanners not counted); **Reports → Google review links**.
- Optional follow-up a set number of hours after the visit, per location: opt-in only, STOP and email opt-outs, quiet hours, once per ticket and at most every N days per client. No review gating.
- Migration `core_0039_google_reviews`. Tests: `tests/reviews.test.ts`, `tests/db/google-reviews.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, and no consent columns were written.

### 2026-10-23: core (digital receipts)

- Receipts are a text with a link, an email, or none; paper is off unless a shop turns on the Print button. The number or email on file is offered first, masked for staff whose client-data settings mask or hide it.
- A branded receipt page per link (`/receipt/{token}`): shop info, items, tip, fee, tax, card brand and last 4, the barber's first name, loyalty, Rebook and Leave a review.
- Refunds and voids send an updated receipt; staff resend from the ticket or the client's purchases; clients ask for copies at `/receipt`.
- Migration `core_0038_digital_receipts`; settings `reviewUrl`, `allowPrint`. The hand-off receipt step goes through the same code.
- Tests: `tests/receipts.test.ts`, `tests/db/receipts.test.ts`, and the receipt step in `tests/db/handoff.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, and no consent columns were written.

### 2026-10-23: core (customer screen at checkout)

- **Hand to customer** on the POS turns the device to the client: tip (the brand's or the shop's buttons, custom, no tip, with the credit surcharge shown), signature (optional per shop), receipt (text, email or none) and payment (reader, Elements or test cards; cash goes back to the counter). The device is locked to that ticket until a staff or manager PIN, per shop; after payment it goes back by itself after the thank-you screen, or waits for a PIN.
- Tips on the Stripe Terminal reader per shop: the first three buttons are pushed to a Terminal configuration on the shop's Location. The reader itself is still simulated.
- Split tips: a barber per line and the tip split by services or evenly, through the ledger, tip payouts, reports and payroll.
- Settings: Shop settings, the brand's tip buttons and the Add Location wizard (the old tip presets field moved into **Customer screen at checkout**).
- Migration `core_0037_handoff`; permissions `handoff.unlock`, `handoff.settings`; the middleware matcher change above.
- Tests: `tests/handoff.test.ts`, `tests/db/handoff.test.ts`. `tests/db/session.ts` keeps the `rayz_handoff` cookie; `tests/network-access.test.ts` checks the new matcher.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`.

### 2026-10-23: core (sign-in restrictions)

- Per-location sign-in restrictions: allowed IPs and CIDR ranges, trusted devices, or either or both, set under **Setup → Sign-in security**, Shop settings and the Add Location wizard. Off for every shop until the brand turns one on.
- Enforced on every `/admin` request in the middleware (now `runtime: "nodejs"`), in `getStaffContext` and at sign-in. Blocked sessions are signed out with "Sign-in is only allowed from the shop."
- The client IP comes only from `clientIp()`: `x-real-ip` on Vercel, `TRUSTED_PROXY_HOPS` self-hosted, otherwise unknown. The time clock's network check now uses it too; before, it read the first `x-forwarded-for` entry, which a client can set off Vercel.
- Migration `core_0036_network_access`; permissions `access.remote`, `devices.approve`, `network.settings`; audit actions `network.*` and `device.*`; notification kind `access_alert`.
- Tests: `tests/network-access.test.ts` and `tests/db/network-access.test.ts`. `tests/db/session.ts` sets `TRUSTED_PROXY_HOPS=1` and keeps the device cookies.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (processor-hosted data)

- **Never stored or logged:** card numbers, bank and routing numbers, SSNs, TINs, EINs, dates of birth for identity checks and ID documents. `src/lib/sensitive.ts` has the rules. `src/instrumentation.ts` and `scripts/worker.ts` scrub every `console` call, and `audit()` scrubs its details. Vendor audits record the supplier account number as `supplierAccount`.
- Migration `core_0035_scrub_sensitive`: the SQL functions `scrub_sensitive_text`, `scrub_sensitive_jsonb`, `is_forbidden_key` and `luhn_ok`, plus `scrub_sensitive_row` triggers on 39 tables covering their 52 free-text columns. On append-only tables it fires on insert only, elsewhere on insert and on updates of those columns. Existing rows were scrubbed once, with one `privacy.scrub_existing` audit entry if any changed.
- SAQ A: the Payment Element takes cards only. Production checkout pages get a Stripe-only CSP (`CHECKOUT_CSP` in `next.config.ts`). The onboarding simulator no longer shows test EIN, birth-date or bank numbers. Tax-form notes are on Location setup and My banking.
- Tests: `tests/sensitive.test.ts` and `tests/db/sensitive-data.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (my banking)

- **My banking** (`/admin/my-banking`, `tips.own`): the employee's Stripe payout account with one of four statuses (not set up, pending verification, ready, action needed), where payouts go (bank or card name and last 4 only), what Stripe needs in plain words with its deadline, their payout method choice (moved from My tips) and the history of changes. Setup and changes are on Stripe's hosted pages.
- Stripe's `account.updated`, `capability.updated` and `account.external_account.created`/`updated`/`deleted` keep the status and destination current. Stripe asking for more notifies the employee once per new request; a new destination or method sends a security notice by email and text and is audited.
- Managers see only each person's method, status and last 4 (a **Payout accounts** card on Tip payouts, and on each Stripe payout in a batch).
- Migration `core_0034_staff_banking`. Notification kind `tip_banking`. Tests: `tests/banking-status.test.ts`, the banking status flow in `tests/db/tips.test.ts`, and updates to `tests/banking.test.ts` and `tests/permissions.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (tip payouts)

- **Tip payouts to employees**: a tip ledger per employee, shop and ticket (card, cash and gift card tips, refunds and voids reversing them, manager adjustments), with card tips pending settlement until the shop's delay has passed.
- Per-shop schedules (end of night, daily on a delay, weekly, payroll only, manual) and methods the brand allows (cash from the drawer, Stripe Express to the employee's own card or bank with optional instant payout, through payroll). Employees choose where the brand lets them.
- Managers review and approve every batch per employee and ticket; holds, adjustments, removals and cancellations need a reason and are audited. Double payment is refused by claims under row locks, a trigger, unique indexes and Stripe idempotency keys.
- Cash payouts are acknowledged with the clock PIN or name and come off the drawer's expected cash. Stripe payouts reconcile from `payout.*` and `transfer.reversed`.
- Payroll: tips paid outside payroll still go to iSolved as received; tips paid through payroll get their own column and are locked as paid at approve-and-lock.
- **My tips**, **Tip payouts**, **Tip payout settings** and **Reports → Tip payouts**. Permissions `tips.own`, `tips.approve`, `tips.settings`.
- Migration `core_0033_tip_payouts`. Tests: `tests/tips.test.ts`, `tests/db/tips.test.ts`, and additions to `tests/payroll-engine.test.ts`, `tests/permissions.test.ts` and `tests/db/tenant.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (clock block-outs)

- **Clock events are real block-outs now**, replacing the calendar overlay and the online-only holds. Break (or the reason picked, for its planned length or the shop's default, running on while it lasts), Clocked out (to the end of the shift) and an optional soft Not in yet. Clocking back in or ending the break trims them.
- They're marked from the time clock, linked to their punches, and moved, trimmed or removed when a punch is edited, added or voided.
- Same reasons, colors, privacy and permissions as manual blocks. They take the time out of availability (staff booking too), show in who's off, who's blocked and reports, and drive the affected-clients alert and rebook flow (`/admin/call-ins?block=<id>`).
- Managers (`blocks.others`) can change, remove or reset them, each audit-logged. Barbers can't change or remove them.
- Migration `core_0032_clock_blocks`. Tests: `tests/clock-blocks.test.ts` and `tests/db/clock-blocks.test.ts`; `tests/db/clock-live.test.ts` now checks the rows.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (the clock on the calendar)

- **Day calendar:**
  - Each barber's column shows a clock status badge (Clocked in, On break, Clocked out or Not in yet), worked time beside the shift, and shaded breaks.
  - Late, past-start, early-out and missed-punch flags are marked in red.
  - Clients booked in held time are ringed, with a reassign-or-rebook link to the call-in form, which now takes `staff`, `shop`, `from` and `to` in the URL.
  - Today's calendar checks for changes every 15 seconds (`calendarPulseAction`) and redraws without a reload.
- **Availability:** a break or early clock-out holds online time, and an early clock-in can open slots. These are per-shop rules, plus the barber's own permission for early time. See "Time clock" above for what changes under `/api/v1`.
- **Alerts:** not clocked in before the first client, and clients booked in held time. They show on Today and go to managers by email once (from the cron, and right after the punch). Today's who's-in, open chair time and waitlist alerts follow the actual clock.
- Migration `core_0031_clock_live`. Tests: `tests/clock-live.test.ts` and `tests/db/clock-live.test.ts`.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (time clock and hours)

- **Punching:** a phone clock (`/admin/clock`) with the shop's device, GPS or network check, and a front-desk clock (`/admin/clock/kiosk`) on a registered device with personal PINs. Breaks, an optional photo, and the method and location recorded on every punch.
- **Rules:** late, early and stayed-late against the schedule with grace minutes; a warning during time off; forgotten clock-outs flagged with an email and a Today alert; unpaid breaks from 30 minutes; overtime via the existing payroll rules; overnight and DST handled.
- **Timesheets** per person, shop and period:
  - Manager edits with a reason, written to the edit log and the audit log.
  - Employee then manager approval, then a period lock.
  - Scheduled vs actual hours.
  - FT/PT rolling averages over 4, 8, 12 or 13 weeks, with crossing alerts.
- **Payroll export:** a generic CSV and an iSolved-friendly CSV, with configurable columns. **Reports:** Labor hours and cost (rates gated by `payroll.rates`) and Attendance.
- **Fixes found while testing:**
  - An overnight shift over a week boundary lost its after-midnight hours from that week.
  - A shift still in progress counted as a missed punch.
- Migration `core_0030_time_clock`. Tests: `tests/time-clock.test.ts` and `tests/db/time-clock.test.ts`. The tenant test covers the new page.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (per-location banking)

- **Payments mode per shop** (`connected`, `brand` or `cash_only`), chosen in the Add Location wizard's new **Payments and banking** step and in Location setup. Only holders of `payments.banking` (an owner grant) can choose it, onboard or change the descriptor.
- **Wizard step:** mode, statement descriptor, card fee and tips (moved here), readers by registration code, and receipt branding. The done screen goes straight to Stripe onboarding.
- **Go-live gating:** the checklist blocks go-live until Stripe enables charges on a shop's own account. A brand-account shop is ready right away; a cash-only shop passes with the cash-only waiver.
- **Routing:** `chargeRoute` sends each charge, tip and gift card sale to the brand account or the shop's account, and refuses cash-only shops. Refunds follow the original account. POS picks the shop's own readers and disables Card when the shop can't take cards.
- **Payouts page** at `/admin/payouts` (per shop and brand-wide, with fees and refunds). Shop P&L reconciles brand-account shops. Today flags failed payouts.
- **Receipts** use each shop's branding (`shops.receipt`).
- Migration `core_0029_location_banking`.
- Tests: `tests/banking.test.ts` and `tests/db/banking.test.ts`. The tenant test covers the new actions.
- **Not touched:** `/api/v1`, `api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent.

### 2026-10-23: core (self-service locations, Today, morning digest)

- **Review fixes first:**
  - The booking SMS opt-in now starts unchecked, with TCPA wording.
  - Payroll tips and sales leave out Squire-imported tickets.
  - `audit_log` and `gift_card_ledger` are append-only (`core_0026_append_only`), and refunds are indexed by sale.
- **Locations (`core_0027_locations`):**
  - The Add Location wizard (`/admin/setup/new`, `locations.setup`) and the lifecycle described above.
  - A go-live checklist with required steps, temporary close, and archive. Archive is refused while appointments, open tickets or an open drawer remain, and it keeps all history.
  - Branding, card readers (`terminal_readers`) and shop vendor accounts (`shop_vendors`).
  - Booking, the public site, call-ins, POS and every picker respect status. Reports and permissions include archived shops, labelled "(archived)".
  - Only `America/Chicago` can go live.
- **Self-service:**
  - Staff offboarding: `active = false`, `sessions_valid_after = now`, schedules removed and recurring blocks ended. Booked appointments are listed to move.
  - Brand-editable client messages (`brand_settings.message_templates`, with merge fields).
  - Picklists (`brand_settings.lookups`).
  - New permission `settings.lists`.
- **Today:**
  - `src/server/today.ts` builds alerts per viewer, scoped by shop and gated by permission. The actions in `src/app/admin/today/actions.ts` work each alert out again on the server before acting.
  - Texts go through `src/server/outreach-campaigns.ts`, deduplicated in `client_nudges`. Dismissals are stored in `alert_dismissals`.
  - New notification kinds: `fill_offer`, `rebook_nudge`, `no_show_reminder`, `running_late` and `digest`.
- **Morning digest:**
  - Built in `src/server/digest.ts` and set up at `/admin/digest`; settings live in `brand_settings.digest`.
  - The notifications cron sends it, once per person per day (`digest_sends`).
  - `core_0028_digest_jobs` lets `digest` jobs have no shop.
- Tests:
  - New: `tests/db/locations.test.ts`, `tests/db/today.test.ts`, `tests/today.test.ts` and `tests/message-templates.test.ts`.
  - Changed: `tests/ratings.test.ts` now allows the permission catalog's `client_ratings` report key. The cron reaches that file through the digest; it isn't the table.
- **Deferred by decision:**
  - I10 separate charges, `payment_transfers` and tip transfers: destination charges stay.
  - The Q11/C2 flag stays off.
  - Merging PR #8.
  - `DEMO_MODE` in production, because it breaks the Vercel demo.
- **Not touched:** anything under `/api/v1`, `src/server/api.ts`, `api-schemas.ts`, `openapi.ts`, `auth/customer.ts`, `importer.ts`, or consent. The cron route imports from `@/server/api` but doesn't change it.

### 2026-10-23: core (call-ins)

- **Call-ins** at `/admin/call-ins`: a manager (or a barber with `callins.mark_own`) marks a barber called in (sick, emergency or other) for a whole day, part of a day or a range. It writes a time off block that shows on the calendar and lists every affected appointment.
- Per appointment, or one choice for all: move to a free barber (same shop, or another shop when the client allows it), with a text and a decline option; text and email a sorry note with the original time and a one-tap rebook link (`/r/[token]`, keeps the service and add-ons, any barber or a chosen one); or an automated Twilio call (press 1 for the link by text, 2 for the shop, voicemail message, 9 for no more calls).
- Replies: "1" takes the offered time (or keeps the move), "2" declines. Anything else lands in the shop's **Inbox**, where staff answer without seeing the number when it's masked for them.
- Shop line: each shop's Twilio number forwards to the shop phone. Missed and after-hours calls get a booking (or rebook) text, at most one per number and shop every 12 hours. Calls are logged on the client's profile, and click-to-call bridges through the shop line.
- Tracking per appointment, one retry after the follow-up wait with no answer, then flagged for staff. New **Call-ins** report by shop and barber.
- Quiet hours, opt-ins and STOP are respected. Everything is off until Twilio keys are set; the outbox and the call and text simulator work without them.
- Migration `core_0025_call_ins`. Grants: Brand Admin, Regional Manager and Shop Manager get mark, outreach, calls, inbox and the report; the front desk gets outreach and the inbox; `callins.mark_own` is on Brand Admin only. Custom roles get mark, outreach, calls and the report with `timeoff.approve`, and the inbox with `calendar.manage`.
- Tests: `tests/outreach.test.ts` and `tests/db/call-ins.test.ts`. `tenant.test.ts` covers the new pages and actions.
- **Not touched:** anything under `/api/v1`.

### 2026-10-23: core (block reasons)

- Every block and time off entry has a reason from a brand list (Lunch, Break, Bank, Doctor, Personal, Vacation, Sick, Training, Meeting), plus an optional note. Managers edit the list at `/admin/block-reasons`, each with a color, what it's for, and whether it counts as lunch, skips the notice and is private.
- The day calendar writes the reason on the block in its color, with the note on hover or tap. New **week view** for one barber (`/admin/calendar?view=week`).
- Private reasons (Doctor and Sick to start) are masked on the server for people without `blocks.private`, except for the barber's own entries. Calendar, dashboard, time off page, staffing report and CSV, and the audit log (entries and search) all apply it. Online booking never sees reasons.
- The staffing report has a **Time off for** column, notes beside each reason, and a **By reason** hours table.
- Migration `core_0024_block_reasons` seeds the list, maps existing entries by category and reason, and grants `blocks.private` and `blocks.reasons` to Brand Admin, Regional Manager and Shop Manager. Custom roles get `blocks.private` with `timeoff.approve`, and `blocks.reasons` with `settings.shop`.
- Tests: `tests/block-reasons.test.ts` and `tests/db/block-reasons.test.ts`. `tests/db/staff-time.test.ts`, `tenant.test.ts` and `slot-timing.test.ts` moved to reason ids.
- **Not touched:** anything under `/api/v1`.

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
