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

## Log

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
