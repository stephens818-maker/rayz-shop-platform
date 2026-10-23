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

Neither agent edits the other's files. If you need a change in the other side's file, put it under "Requests" below or in a PR comment.

## Rules both sides follow

- **Migrations are additive only.** Never rewrite, squash or renumber an existing migration. The core agent's new migrations are named `core_NNNN_<name>.sql` in `drizzle/` (the `_journal.json` tag matches the filename). The mobile agent uses its own prefix. Migrations up to `0019_slot_timing` already exist and stay as they are.
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
- `payments` gains Connect columns. See the I10 section below once it lands.

## Requests for the other agent

- (core → mobile) When you add the platform Stripe Customer and saved cards, pass the platform Customer id into `chargeCard({ customerId, paymentMethodId, ... })` in `src/server/payments/processor.ts`. That function routes the charge to the shop's connected account (I10), so a saved card can pay at any shop. Please don't create PaymentIntents anywhere else.

## Open questions

- Which C/I/S items does "brand-sync registry" refer to? See above.
- C18 review login and the wallet fee: flags are off until Charles decides. Mobile reads `flags.reviewLogin()` and `flags.walletFee()` (`FEATURE_REVIEW_LOGIN`, `FEATURE_WALLET_FEE`). Both stay off.

## Mobile API workstream (bc-645fbcc0)

Branch: `cursor/mobile-api-auth-a9e1`. PRs into `cursor/rayz-barbershop-v1-8f0b`. Migrations use the `mobile_` prefix and stay additive. Journal tag `mobile_customer_app` is idx 20 (after `0019_slot_timing`). If core adds idx 20 first, this entry gets the next index; the SQL file name does not change.

### Auth tokens

- Access JWT: 1 hour, HS256, `Authorization: Bearer`.
- Refresh: rotating, 60 days. Reuse revokes the family.
- OTP purposes: `signin`, `email_change`, `delete`, `step_up`. Email is not a login identifier until `email_verified_at` is set. `PATCH /api/v1/me` rejects `email`.
- ios/android must send `X-App-Version`. Below `app_config` minimum returns 426 `upgrade_required`. Missing `X-Client` stays allowed (website, cron, tests).

### Customer / Stripe

- Platform Customer and saved cards are still landing on this branch. Pass the platform Customer id into the shared charge path below. Do not create a second PaymentIntent helper.
- Shop columns, added here because the owner assigned them to the mobile migration before I10 landed:
  - `shops.stripe_account_id`
  - `shops.owner_entity_id` uuid, nullable, no FK (franchise hook)
  - `staff.stripe_account_id` optional Express account. Barber onboarding is optional (`createBarberConnectOnboardingLink`).
- **Do not hard-wire destination charges.** `chargeCard` stays the low-level platform charge POS already calls. Connect routing is `executeChargePlan` in `src/server/payments/charge-plan.ts`. It supports `destination` and `separate_charges_transfers`. The default is separate charges and transfers: charge on the platform with `on_behalf_of` = the shop, then transfer with `source_transaction` and `transfer_group`. `destination` is selected only with `kind: "destination"` or `CHARGE_PLAN_KIND=destination`, and it cannot pay a barber (no connected-to-connected transfer). POS checkout should call `executeChargePlan` for the same routing. Live keys are refused.
- **Tip-to-barber is OFF.** It runs only when `FEATURE_TIP_TO_BARBER` is exactly `"true"`. The label is `not for W-2 employees, pending CPA`. Employee tips are expected to go through iSolved payroll. While the flag is off, the tip stays in the shop transfer and the ledger records a `tip` row with status `skipped` and that note. The flag lives next to the charge plan, not in `src/lib/flags.ts`.
- Ledger: `connect_transfers` stores planned vs executed rows (`shop_net` | `tip`), plus reversals. `reverseChargePlan` claws a tip transfer first, then the shop transfer, and refunds the charge. A destination plan refund sets Stripe `reverse_transfer`. A skipped tip has nothing to claw back.
- Hosted shop onboarding: `POST /api/v1/internal/connect/onboard` with `IMPORT_SECRET` or `CRON_SECRET`. Body `{ shop }`. Test mode only. No secret key: simulator id `acct_sim_<slug>`.
- **Conflict to resolve:** core NOTES assign I10 to core and say `chargeCard` will route to the shop's connected account. At `c959576` `chargeCard` still charges the platform key only, and a destination charge cannot pay a barber Express account. Mobile built `executeChargePlan` as the shared interface instead of hard-wiring destination into `chargeCard`. If core's I10 replaces that function, write the new signature here and mobile will follow. Please don't add a second PaymentIntent helper.

### Card fee

Mobile calls `computeCardFee` in `src/server/payments/card-fee.ts` and does not reimplement it. Amounts are `{ chargeCents, tipCents? }`. Wallet fees stay off via `flags.walletFee()`.

### Consent

- `consent_events` is the record. Channels: `sms_transactional`, `sms_marketing`, `email`, `email_marketing`, `push_transactional`, `push_marketing`.
- `retainOptOut` in `src/server/mobile/consent.ts`: once a flag is false, a later booking or Squire row that says yes does not turn it on. Only `recordConsent` (which writes the event) can grant it again.
- `findOrCreateCustomer` and the client importer both use that rule. A new row may be created already opted in, and that insert writes a consent event.
- Imported Squire opt-in is transactional only. Marketing flags stay false. STOP revokes both SMS channels. START grants transactional only.

### /api/v1 additions in this pass

- Per-IP limits when `X-Forwarded-For` or `X-Real-IP` is present: 600/hour on `/api/v1/*`, 20/hour on `POST /auth/otp/start`, 30/hour on `POST /appointments`. OTP is also 5/identifier/hour and 10/device/hour. No IP header is not counted.
- `GET /appointments/{code}`: a bearer token must own the appointment. With no token the code works only until `cancelCutoffAt`.
- `GET /shops` includes `lat`, `lng`, `openNow`, `nextSlot`, `bookingMode`, and the card-fee disclosure.
- `GET /me` returns `notes` / `preferences` (the customer's own note). Staff `customers.notes` are not returned.
- `GET /me/purchases` returns tickets and `lastProduct`.
- `POST /me/devices` registers an APNs, FCM, or Expo token. `DELETE /me/devices/{id}` revokes that device.
- Customer-facing barber names from `getAppointmentByCode`, `messageContext`, and `GET /shops/{shop}/barbers` are first names. `shopBarbers` (admin) is unchanged.

### Import

- Dry-runs roll back in batches of 500 (`IMPORT_BATCH_ROWS` overrides) instead of one transaction, and keep an in-memory preview so a later batch still sees duplicates. Live imports were already batched.
- A non-id match replaces non-empty name, phone, email, home shop, and preferred barber. Consent still cannot be turned back on.
- **Imported appointments do not text or email by default.** `runImport(..., { notifyClients: true })` is the only switch, and it still goes through `scheduleAppointmentNotifications`, which sends only to an opted-in phone or email. The default is off for bulk and delta imports. When it is on, an imported booking schedules reminders only (no new confirmation).
- **Imported sales stay marked.** `sales.is_imported` stays true and `payments.processor` stays `squire_import`. Payroll and the drawer already exclude those. Do not clear either mark.

### Requests for core

- **Web booking checkbox defaults to on.** `src/app/(public)/book/[shop]/wizard.tsx` initializes `smsOptIn: true`. Please default it to off. The API will not turn texts back on after an opt-out, but a brand-new guest whose box is pre-checked is still stored as opted in.
- When POS adopts Connect, call `executeChargePlan` (not a second PaymentIntent helper, and not a destination hard-wire on every `chargeCard`). Leave tip-to-barber off. Employee tips go through iSolved.

### Open on this side

- Charles: deletion grace, badge thresholds, whether loyalty pools to a guardian, Android SHA-256 for asset links.
- App Review login stays off.

## Log

### 2026-10-23: mobile (bc-645fbcc0)

- Opt-out sticks in `findOrCreateCustomer` and the Squire client importer. Re-consent is a `consent_events` row.
- Dry-run import is batched. Non-id matches update changed contact fields.
- Per-IP limits, appointment code cutoff, push device registration, purchase history, customer notes, shop geocode / open-now / next slot.
- `executeChargePlan` defaults to separate charges and transfers. Tip-to-barber stays off, labeled "not for W-2 employees, pending CPA"; employee tips go through iSolved. Ledger is `connect_transfers`.
- Import `notifyClients` defaults off. `is_imported` and `processor = 'squire_import'` are unchanged so payroll can exclude imported tickets.
- Reads core `computeCardFee` and `flags.reviewLogin` / `flags.walletFee`.

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
