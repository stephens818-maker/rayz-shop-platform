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
| I10 Stripe Connect: platform account, connected account per shop, destination charges, onboarding, per-shop P&L, per-location banking (payments mode, descriptor, Terminal Locations and readers, payouts) | core, except the platform Customer and saved-card side, which is mobile's |
| Payroll (`src/domain/payroll/**`, `src/server/payroll/**`, `src/app/admin/payroll/**`) and service times (`src/domain/service-times.ts`, `src/server/service-times*.ts`) | core |
| Time clock and timesheets (`src/domain/time-clock.ts`, `src/server/time-clock*.ts`, `src/server/labor-report.ts`, `src/app/admin/clock/**`, `src/app/admin/timesheets/**`, `src/app/admin/time-clock/**`) | core |
| Tip payouts (`src/domain/tips.ts`, `src/server/tips/**`, `src/app/admin/tips/**`, `src/app/admin/my-tips/**`), including employees' Stripe Express accounts | core |
| Staff sign-in restrictions (`src/domain/network-access.ts`, `src/server/auth/network.ts`, `src/server/sign-in-security.ts`, `src/middleware.ts`, `src/lib/client-ip.ts`, `src/app/admin/sign-in-security/**`) | core |
| Customer screen at checkout and split tips (`src/domain/handoff.ts`, `src/server/handoff.ts`, `src/server/auth/handoff-lock.ts`, `src/app/handoff/**`) | core |
| Digital receipts (`src/domain/receipts.ts`, `src/server/receipts.ts`, `src/app/receipt/**`, the ticket's receipt panel). The consent itself (opt-ins, wording, STOP) stays mobile's; receipts only read it | core |

Neither agent edits the other's files. If you need a change in the other side's file, put it under "Requests" below or in a PR comment.

## Rules both sides follow

- **Migrations are additive only.** Never rewrite, squash or renumber an existing migration. The core agent's new migrations are named `core_NNNN_<name>.sql` in `drizzle/` (the `_journal.json` tag matches the filename). The mobile agent uses its own prefix. Migrations up to `0019_slot_timing` already exist and stay as they are. The core side has since added `core_0020_stripe_connect`, `core_0021_service_times`, `core_0022_payroll`, `core_0023_staff_time`, `core_0024_block_reasons`, `core_0025_call_ins`, `core_0026_append_only`, `core_0027_locations`, `core_0028_digest_jobs`, `core_0029_location_banking`, `core_0030_time_clock`, `core_0031_clock_live`, `core_0032_clock_blocks`, `core_0033_tip_payouts`, `core_0034_staff_banking`, `core_0035_scrub_sensitive`, `core_0036_network_access`, `core_0037_handoff`, `core_0038_digital_receipts`, `core_0039_google_reviews`, `core_0040_review_visits`, `core_0041_marketing` and `core_0042_campaign_center`.
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
- **Stripe:** employees' Express accounts send their events to the Connect webhook (`/api/stripe/connect`): `account.updated`, `capability.updated`, `account.external_account.*` and `payout.paid`/`failed`/`canceled`. The platform webhook handles `transfer.reversed`. Transfers come from the shop's connected account (an account debit, then a transfer with `source_transaction`) or the brand's balance.
- **Payroll:** `payrollTipSplit` gives each line `tipsInPayroll`, `tipsOutside` (still `E_Cash Tips Recd_Dollars`) and `tipsPaidOut`. The iSolved file gets an extra column (`tipsInPayrollHeader`, default `E_Tips Paid In Payroll_Dollars`) only when someone has tips paid in payroll. `lockPayrollTips` runs inside approve-and-lock.
- **Permissions:** `tips.own`, `tips.approve` and `tips.settings` (brand-only), and the report `tip_payouts`. There are 77 feature permissions now.
- **Notification kinds:** `tip_payout`, to the employee (email, or a text if they have no email) when a payout is sent or fails, and to the shop's email when one fails. `tip_banking`, to the employee: Stripe needs more information (email, or a text without one), and security notices when the payout destination or method changes (email and text).
- **Cron:** `/api/cron/notifications` runs `tipPayoutCron`, which builds each live shop's daily or weekly draft once it's due. The response gains `tipPayouts`.

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
  - Server: `src/server/coupons.ts`, `src/server/booking-drafts.ts`, and `src/server/marketing/` (`consent`, `audiences`, `engine`, `campaigns`, `links`, `report`, `settings`).
  - Routes: `/admin/campaign-center` (campaigns, blasts, settings, `/export`), `/admin/reports/campaign-center`, `/api/cron/campaign-center`, and `/m/{token}` and `/m/{token}/unsubscribe` (unchanged, since they're in messages already sent).
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
  - Other: `campaign_center.export`, `brand.campaign_center_settings`, `promo.create`/`.update`, `customer.tags`. Rows written before the rename keep their `marketing.*` and `brand.marketing_rules` names.
- **If the app takes coupons or bookings:**
  - **Bookings:** check and hold a code with `checkBookingCoupon(shopSlug, code)` and `holdBookingCoupon(appointmentCode, code)` right after booking, so the POS picks it up.
  - **Checkout:** redeem only through checkout's `redeemCoupons` (it re-checks limits under a lock), and never increment `promo_codes.redemptions` yourself.
  - **Unfinished bookings:** `saveBookingDraft` and `finishBookingDraft` feed the "Finish your booking" campaign.
- **Push:**
  - Marketing push jobs have `channel = 'push'` and `to` set to the `customer_devices.id`.
  - The provider (`NOTIFICATIONS_PUSH_PROVIDER`) is `disabled`, `console`, `simulator` or an `expo` stub.

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
- `payments` gains Connect columns. See the I10 section above, and `settlement` and `terminal_reader_id` in the per-location banking section.
- `shop_payouts.shop_id` can be null (brand-account payouts). Join with a left join.

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

## Open questions

- Which C/I/S items does "brand-sync registry" refer to? See above.
- C18 review login and the wallet fee: flags are off until Charles decides.
- I10 fee model: the platform keeps an application fee equal to the processing estimate, and doesn't return it on refunds, so each shop's P&L carries its own card cost. Charles to confirm, or name a platform margin on top.
- Payroll, pending Charles: Q11 (do clocked hours already include training? The C2 flag stays off), Q17 (the owner row and the Coralville NetComm gap, flagged and not fixed), the full-time hours basis and window (default: clocked worked hours over a rolling 4 weeks), and 2-decimal half-up rounding of the export (off).
- Time clock, pending the owner or the accountant:
  - Iowa and Illinois overtime rules. It's federal weekly-over-40 for now, with optional daily OT as a setting.
  - The exact iSolved import template: column names and earning codes. The layout is configurable.
  - Meal break rules: 30 minutes or more is unpaid by default, and the auto-deduction is off.
  - Each shop's real coordinates and network addresses. The seeded ones are approximate.

## Log

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
