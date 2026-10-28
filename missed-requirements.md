# Outstanding requirements

Everything the owner asked for that isn't finished yet, in the order it's being worked on. Each item is ticked when it's merged into [PR #1](https://github.com/stephens818-maker/rayz-shop-platform/pull/1), and moves to the README's "What's done" at that point.

## 1. Private hosted preview

- [x] Vercel-ready config (`vercel.json`, the `vercel-build` script, Neon connection strings).
- [x] Demo data: 8 shops, barbers by first name, about 3,000 clients with families on a shared phone, appointments, sales, inventory, vendors, purchase orders.
- [x] Demo logins: brand owner, a shop login, a shop manager, a barber, with one-click sign-in.
- [x] Stripe, texts, and email in safe mock or test mode (`DEMO_MODE=true`).
- [x] `DEPLOY.md` with the exact steps, accounts, and environment variables.
- [x] A permanent preview URL: the Vercel branch alias of `cursor/rayz-barbershop-v1-8f0b` on the owner's Neon database, rebuilt and migrated on every push (NOTES-SYNC, 2026-10-27). Vercel Authentication stays on; testers get Charles's share link, which is never written in this public repo. Demo clients get marketing consent on the first build (`scripts/demo-consent.ts`), so Campaign Center can be tried.

## 2. UX and design standard (applies to every screen)

- [x] Design tokens for color, type, spacing, radius, and shadow, with light and dark mode; Inter. Tokens live in the `@theme` in `src/app/globals.css`, and dark mode in `src/app/dark.css`. Inter is self-hosted with `next/font`. The theme is Light, Dark or Auto, chosen per device, and Light by default.
- [x] Consistent components, with shadcn/ui-style primitives on Tailwind (`src/components/ui.tsx`, plus `skeleton.tsx`, `toast.tsx`, `bar-chart.tsx`).
- [x] Micro-interactions and transitions; skeleton loaders instead of spinners; optimistic updates. Every staff page has a `loading.tsx` skeleton, with page-shaped ones for the calendar, checkout, reports, clients and sales. A calendar drag shows at its new time before the server answers.
- [x] Empty states with helpful calls to action; toast feedback (`toast()`, used by `useAction` when the caller passes a confirmation).
- [x] Cmd/Ctrl-K command palette and global search: pages, reports, shop switching, actions and clients (masked as on `/`). It opens from **Search…** in the sidebar on touch screens.
- [x] Keyboard shortcuts on the calendar and checkout, plus `G` then a letter to jump, and `?` for the list (`src/domain/shortcuts.ts`).
- [x] Drag-and-drop on the calendar: moving to another time or barber, or onto the pager arrows to reach barbers on another page.
- [x] Touch-friendly tablet layouts for the front desk, checkout, and the tip hand-off. The day board fits its barbers across the screen and pages them. Checkout shows the ticket and payment side by side from 768 px, with a total bar on phones. The customer screen was already full-screen on a tablet.
- [x] Fully responsive mobile views for barbers. No staff page scrolls sideways at 390 px (14 pages checked, plus the public home, locations, shop and booking pages). Report categories, report links, date presets and pay periods stay one row that swipes (`src/components/chip-strip.tsx`), with the current one in view.
- [x] Fast page loads. Skeletons show at once, and reports print their load time. Lighthouse on Today, calendar, sales, a report and clients (production build, seeded data): performance 94 to 100 on mobile (simulated slow 4G, 4x CPU; LCP 1.2 to 1.8 s, no layout shift) and 100 on desktop; best practices 100.
- [x] WCAG AA accessibility. A skip link, focus rings everywhere, reduced motion, `aria-pressed` on tip and tender buttons, and combobox, listbox and status roles. axe (WCAG 2.1 A and AA) finds no violations on 14 staff pages in light and dark mode and at phone width, and Lighthouse accessibility is 100. Muted text and the pale accents are darkened as text only (`globals.css`, with a test on the ratios); inputs, scrolling tables and calendar items are named; pager dots are 24 px targets.
- [x] Polish pass on the calendar, checkout, client profile, reports, and brand portal, with before and after screenshots in the PR.

## 3. Customer notifications and calendar integrations

**SMS (Twilio)**

- [x] Real Twilio API calls: each shop's own Twilio number, else the Messaging Service SID, else `TWILIO_FROM`. Not yet tried against a real account (see section 10).
- [x] Status-callback webhook with signature verification (`/api/twilio/sms/status`; every `/api/twilio/**` route checks `X-Twilio-Signature`).
- [x] STOP and START replies update the client's opt-in (STOP turns off "OK to text" for every client on the number; START restores those same clients). HELP is answered by Twilio and only recorded.
- [x] Configured by `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM`); off until they're set. The outbox and a call and text simulator stay for development.
- [x] A2P 10DLC registration notes in the README and DEPLOY.md.

**Email (Resend, or Postmark behind the same interface)**

- [x] Real API calls to Resend (`RESEND_API_KEY`) and Postmark (`POSTMARK_SERVER_TOKEN`) from `EMAIL_FROM`, off until the key is set. Client emails go out in the brand's HTML layout with the plain text alongside, a stop link (`/u/e/<token>`) and the one-click `List-Unsubscribe` headers. Campaign Center keeps its own unsubscribe and uses Postmark's broadcast stream. Not yet tried against a real account.
- [x] Bounce and complaint webhooks (`/api/email/resend`, Svix-signed; `/api/email/postmark`, basic auth). Hard bounces, complaints and the stop link add the address to `email_suppressions`, turn off "OK to email" and add a Campaign Center unsubscribe, audited. Delivered events mark the email delivered.

**Push** (owned by bc-645fbcc0, the mobile workstream: devices and push)

- [ ] Web Push (VAPID) for the booking site and the installable PWA. Owned by bc-645fbcc0 (NOTES-SYNC "Who owns what").
- [ ] FCM and APNs-ready through the mobile API, with a device token registration endpoint. Owned by bc-645fbcc0. Core already sends app push for Campaign Center to `customer_devices` through `NOTIFICATIONS_PUSH_PROVIDER` (Expo stub).
- [ ] Customers opt in from the browser or the app. Owned by bc-645fbcc0.

**Reminder rules** (brand portal, with per-shop overrides)

- [x] Booking confirmation.
- [x] Reminders 24 hours and 2 hours before, with editable timings: a brand default each location can override (Settings → Brand defaults → Client notifications), and a barber's own times win.
- [x] Reschedule and cancel notices.
- [x] A "running late" message sent by staff (Today).
- [x] A rebook nudge X weeks after the last visit (Today's rebook nudges, the checkout rebook reminder, and Campaign Center's rebook-by-usual-interval automation).
- [x] A no-show follow-up (Campaign Center automation, per location).
- [x] An optional birthday message (Campaign Center automation, per location; marketing consent).
- [x] Templates with merge fields: client first name, shop, barber first name or display label, date and time, manage-booking link (Settings → Messages).
- [x] Quiet hours in America/Chicago: reminders move out of the brand's quiet hours (Call-ins rules) to when they end, or the evening before when that's too close to the appointment.
- [x] Sent through a background job queue with retries and dedupe (`notification_jobs`, `SKIP LOCKED`, backoff, pending reminders replaced on every move).
- [x] Sent even when staff can't see the client's contact details (masking applies only to staff views).

**Consent** (owned by bc-645fbcc0, the mobile workstream)

- [ ] Separate SMS, email, and push opt-ins, captured at booking with TCPA-compliant wording, a timestamp, and the source. Owned by bc-645fbcc0; core reads them (PR #8's marketing columns).
- [x] Opt-outs stick on core's side: STOP (`contact_opt_outs`), email bounces, complaints and the stop link (`email_suppressions`) and Campaign Center unsubscribes are checked before every send, whatever an import or booking later sets on the client.
- [ ] Default to opted out. Owned by bc-645fbcc0 (the booking form's consent capture).

**Add to calendar** (when the customer allows it)

- [x] Google, Apple/iCal (.ics download), and Outlook on the booking page; all three links in the email; texts link to the booking page.
- [x] Includes the shop address, the barber's display name, and the manage link.
- [x] Reschedules and cancels send an updated or cancelled event (same UID, higher SEQUENCE).
- [x] An optional per-customer calendar feed URL (`/cal/<token>.ics`, theirs and their kids' appointments) on the account page, replaceable and revocable, audited. The `/api/v1/me/calendar-feed` mount is the mobile side's (NOTES-SYNC).

**Delivery tracking**

- [x] Status per message: queued, sent, delivered, failed, opted out (and not sent when the channel is off).
- [x] Shown on the calendar's appointment panel and the client profile, with the number or email as the viewer's client field rules allow, for their shops.
- [x] A notifications report by shop (Notifications → By shop), per channel and status, with text segments and the estimated cost.

**Tests**

- [x] Scheduling and timing, including DST (`tests/notification-delivery.test.ts`: both 2026 changes).
- [x] Quiet hours (call-in outreach: `tests/outreach.test.ts`, `tests/db/call-ins.test.ts`; reminders: `tests/notification-delivery.test.ts`).
- [x] Dedupe on reschedule (`tests/db/notification-delivery.test.ts`).
- [x] The STOP webhook and opt-out persistence (`tests/db/call-ins.test.ts`: STOP suppresses later texts, START restores, 9 stops automated calls; bounces, complaints and the stop link in `tests/db/notification-delivery.test.ts`).
- [x] .ics content and updates (`tests/location-profile.test.ts`, `tests/db/notification-delivery.test.ts`: same UID, CONFIRMED then CANCELLED, the feed).
- [x] Webhook signature checks (Twilio, `tests/outreach.test.ts`; Resend's Svix signature and Postmark's credentials, `tests/notification-delivery.test.ts`).

## 4. Booking time increments

- [x] Brand, shop, barber and barber-at-shop slot intervals, where the most specific wins.
- [x] Service duration steps, booking increments, and prep and cleanup buffers.
- [x] Per-barber durations.
- [x] The day calendar draws each barber's own grid, with drag-and-drop moves and a squeeze-in that needs a permission and is logged.
- [x] DB tests for mixed grids, multi-shop barbers, interval changes under existing bookings, buffers and DST days.

## 5. Stripe Connect, merchant of record (I10)

- [x] One platform account, and a connected (Express) account per shop.
- [x] Separate charges and transfers (Charles approved, 2026-10-28): each sale is charged on the platform with its `transfer_group`, and the shop's portion (services, products, tax and the card surcharge, less the processing fee) is transferred to the shop where the service happened, with `source_transaction`. `chargeCard` and `settlement.ts` are the only charge and transfer path (`tests/charge-path-guard.test.ts`).
- [x] Each card tip is transferred to the barber's recipient account the same way (section 49). `FEATURE_TIP_TO_BARBER` is on at launch (Charles's CPA approved direct Stripe tip payouts, 2026-10-28) and is the brand-wide kill switch (`false`); each shop has its own, the Brand Owner's, on Tip payout settings (`core_0136`). Off, the tip is in the shop's transfer and goes on the paycheck. Every tip goes to iSolved either way, as `E_Cash Tips Recd_Dollars` (taxed, not paid again in the check).
- [x] Refunds and disputes reverse the shop's transfer only, never a tip; a won dispute is transferred back. What the shop's transfer can't cover stays with the platform. Payments from before keep their destination-charge refunds. `tests/db/separate-charges.test.ts`.
- [x] Shops that aren't onboarded can't take cards. Shops can also use the brand account or take cash only (see section 13).
- [x] The location setup wizard creates each shop's account and runs Stripe-hosted onboarding, with a simulator stand-in when there are no keys.
- [x] The Connect webhook tracks account status, disconnects and payouts.
- [x] Owner entities (brand or franchisee) group shops. A franchisee can own several shop accounts.
- [x] The "Shop P&L by Stripe account" report, grouped by owner.
- [x] Platform Customers and saved cards: `chargeCard` accepts the Customer. The Customer and saved-card code is owned by bc-645fbcc0.
- [ ] Try it in real Stripe test mode. This needs test keys with Connect turned on (`STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`).
- [ ] Charles to confirm the fee model: the application fee equals the processing cost and isn't returned on refunds.
- [ ] C18 review login and the wallet fee: the flags stay off until decided.

## 6. Payroll (C4, totals integrity, iSolved export)

- [x] Payroll Report computed row for row like the workbook (33 rows, 293 cells, 0 differences), with every total summed from its rows.
- [x] O.T. Pay (1.5 × base × split OT hours) and Training Pay (setting, on) counted in labor cost; the Locations view's Employee Cost is labor cost.
- [x] Cross-shop OT per Sun–Sat America/Chicago workweek per FEIN, split by share of hours. Tested: 25 h + 20 h, a week spanning two pay periods, a DST week, and the training flag on and off.
- [x] Reconciliation gate blocks approve-and-lock on any $0.01 mismatch and shows it on screen.
- [x] Per-shop pay groups and calendars; Dubuque has its own calendar and file (Q16 resolved).
- [x] Per-shop iSolved xlsx in the workbook's exact format, OT hours only, unrounded by default, formatting copied per tab and diffed in a test. Downloads once the figures are approved (sheet named for the shop, `0.00` by default, the Key's cell type kept). No iSolved API.
- [x] FT/PT: averaging more than 32 h/week; basis and window are settings.
- [x] `docs/payroll-report-spec.md` and the anonymized `docs/payroll-workbook-discrepancies.md`.
- [x] Charles: Q11, training on top of clocked hours, C2 on (§56).
- [ ] Charles: Q17 (the owner row and the Coralville NetComm gap), the FT basis and window, and 2-decimal rounding (off).
- [x] Payroll Report under Reports (Charles's spec): the workbook's Locations tab per shop, totals over every employee, Gross Profit, the Service Sales / Employee Cost / Gross Profit summary, sales tax for reference only, unassigned sales, matching by employee ID, adjustments with reasons instead of typed-over cells, product sales and OT from the system, and xlsx and CSV downloads.
- [x] Run → review (drill-down, anomalies) → approve → lock, with an audit trail. A change after approval makes it stale; take-backs need a reason; approvals can't be edited or deleted (migration `core_0128_payroll_approvals`, DEPLOY step 48).
- [x] Effective-dated rates by checkout date from Staff → Compensation, shown as "mixed" when they change inside a period (needs compensation plans on and Payroll using them).
- [x] iSolved employee number (Key) and iSolved name on Payroll → Setup and the Staff page.
- [x] Golden tests: all 33 rows, the totals and the iSolved file cell for cell, on anonymized committed fixtures; the real ones stay in a gitignored folder. Tests: `tests/payroll-golden.test.ts`, `tests/db/payroll-approval.test.ts`, `tests/db/payroll-reports.test.ts`.
- [x] The workbook totals audit (Claude bot, Oct 22): all 112 flagged Locations cells (71 wrong values, the 6 circular totals, 8 wrong ranges right today, 10 summed rates, 22 missing totals, 1 typed label) are checked against the platform's totals, which equal the audit's correct values to the cent for the golden period, along with the shop tabs, the LeClaire G2/G3 links and the absence of a payroll tax column. `tests/payroll-totals-audit.test.ts`, on the anonymized copy in CI and the real data where it's present (never committed). Anonymized write-up in `docs/payroll-workbook-discrepancies.md`.
- [x] L66, pay day end to end: raw punches at two shops through sign-off, approval, locked hours, Payroll Report approval and lock, each shop's iSolved file cell for cell, and Stripe tip payouts (paid in test mode, held and paid on the paycheck with live keys and the flag off). `tests/db/payday.test.ts`. Run in the sandbox too: the Oct 4–17 period, all 8 shops, locked.
- [ ] Charles (settings until he answers): rounding (unrounded; a NetComm of $307.605 goes out as 307.6049999999999), file names, PTO and training hours from the time clock or a manager (both), and the earning code for card tips (`E_Cash Tips Recd_Dollars`).
- [ ] Enter the real Employee Numbers, iSolved names and rates on Payroll → Setup (they're never in the repo).

## 7. Service time tracking

- [x] Arrival, start, finish and checkout captured with who recorded each; checkout stands in for Finish.
- [x] Manager corrections with audit, outlier flags (left out of averages by default), average, median and count, and duration suggestions.
- [x] Start/Finish on the calendar's appointment panel, the barber's Up next list and the checkout screen; corrections and count/leave-out in the appointment panel.
- [x] The Service times report page with one-click **Use N min** on each suggestion; seeded timings; unit tests (`tests/service-times.test.ts`) and DB tests (`tests/db/service-times.test.ts`).

## 8. Staff self-service: lunch, blocks and time off

- [x] **My time** (phone-friendly) for barbers: blocks with a reason from the brand list and a start and a length; recurring blocks (e.g. lunch every weekday 12:00–12:30, skip one, stop repeating); one-tap **Take lunch now** for 30 minutes. Blocks shade the day calendar and come off online availability at once.
- [x] Time off requests: one day, a range or part of one day, at one shop or all of the barber's shops, with a reason from the brand list and a note. Approval per brand with shop overrides: automatic (only when nothing is booked in the time) or a manager. Pending requests show to managers and are held from online booking; the barber is emailed, and sees the decision on My time and the dashboard.
- [x] Conflicts: blocks and requests over booked appointments warn first and need a confirm. Approval lists the affected appointments; managers move each to a free barber at the same time or ask the client to reschedule through the notification system. Appointments are never cancelled or dropped.
- [x] Permissions: `blocks.own`, `blocks.others`, `timeoff.request` and `timeoff.approve` are separate; nobody decides their own request (Brand Owner excepted). Limits per brand and shop: longest lunch, longest block, minimum notice (sick time exempt). Every block, series, request, decision, move, reschedule ask and rules change is audit-logged.
- [x] Visibility: the **Time off** page per shop (waiting, approved with affected appointments, month calendar, who's off, recently decided, rules); "Off today" on the day calendar; "Who's in today" on the dashboard; the **Who's working, off and blocked** report per day, shop and barber.
- [x] Tests: `tests/staff-time.test.ts` (recurring occurrences across DST, part-day spans, rules and limits, who's in, block and approval permissions) and `tests/db/staff-time.test.ts` (availability removal and skip, series extension and end, part-day time off, pending holds, auto-approve, conflicts, reassign and reschedule, limits, notice, approval permissions, audit).
- [ ] Time off isn't in the `/api/v1` mobile API yet; the app's barbers use the web My time page for now.

## 9. Block and time off reasons

- [x] Every block and time off entry has a reason from a brand-managed list (Lunch, Break, Bank, Doctor, Personal, Vacation, Sick, Training, Meeting) plus a free-text note. Managers edit the list at **Setup → Block reasons** (`blocks.reasons`): add, rename (carried to existing entries), color, reorder, archive and restore; each reason is for blocks, time off or both, and can count as lunch or skip the minimum notice.
- [x] Day and week calendars write the reason on the shaded block in its color; the full note shows on hover or tap. New week view for one barber.
- [x] Per-reason privacy: people without `blocks.private` see just "Blocked" or "Time off", in gray with no note (the barber always sees their own). Masked on the server, so nothing private reaches their browser. Doctor and Sick start private.
- [x] Customers in online booking and `/api/v1` never see a reason, only that the time is unavailable.
- [x] Reasons in the "Off today" banner, "Who's in today", the Time off page (month calendar, who's off, requests), the staffing report and CSV (new Time off for column and By reason table), and the audit log (with redaction and no searching private entries for people without the permission).
- [x] Tests: `tests/block-reasons.test.ts` (defaults, validation, masking, audit redaction) and `tests/db/block-reasons.test.ts` (calendar, pages, CSV, audit and public booking for the desk, the manager and the barber; list editing).

## 10. Call-ins and automated outreach

- [x] Mark a barber called in (Sick, Emergency or Other) for a whole day, part of a day or a range, at one shop or all (`callins.mark`, or `callins.mark_own` for yourself). It writes a time off block with the reason that shows on the calendar, and lists every affected appointment.
- [x] Per appointment, or one choice for all: move to a free barber at the same shop (or another shop when the client allows it), with a text and a way to decline; text and email a sorry note with the original time and a one-tap rebook link that keeps the service and add-ons (any barber or a chosen one); or an automated Twilio call with text-to-speech (press 1 for the link by text, 2 to reach the shop, a voicemail message when a machine answers).
- [x] Two-way texts: reply 1 to take the suggested time (or keep the move), 2 to decline. Other replies land in the shop's **Inbox**, where staff answer through the system; the number stays masked for people who can't see it.
- [x] Shop line: each shop's Twilio number forwards to the shop phone. Missed and after-hours calls get a text with a booking link (or the rebook link for a waiting call-in). Calls are logged on the client's profile when the number matches, and click-to-call bridges through the shop line so staff never see the number.
- [x] Tracking per appointment (notified, delivered, rebooked, declined, no response). After the follow-up wait with no answer, one retry, then flagged for staff. **Call-ins** report by shop and barber.
- [x] Rules: opt-ins, STOP and quiet hours respected; rebook links are tied to one appointment, expire, stop after use or a newer link, and only their hash is stored. Off until Twilio keys are set, with the outbox and call and text simulator for development. Separate permissions for marking, outreach and automated calls, and every action is audited.
- [x] Tests: `tests/outreach.test.ts` and `tests/db/call-ins.test.ts` (affected appointments, reassign versus rebook, link security and expiry, the "1" reply, retries, opt-outs).
- [ ] Try it against a real Twilio account: needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, a number per shop with its webhooks set, and A2P 10DLC registration.

## 11. Self-service locations and settings

- [x] An Add Location wizard (Brand Owner or Brand Admin, `locations.setup`), 12 steps:
  - name, address, phone and time zone (Central by default);
  - hours, with Sunday closed by default, closed days and holidays;
  - service and product tax rates, flagged until verified;
  - payments and banking: own Stripe account, brand account or cash only, the statement descriptor, the card fee and tip buttons, readers and receipt branding (section 13);
  - slot interval and booking rules, and a public booking link that refuses surnames;
  - services copied from the brand or another shop, with overrides;
  - products and par levels, copied or pasted in bulk;
  - vendors with the shop's own account number;
  - staff, including barbers at several shops, and the pay calendar;
  - shop logins and what they can do, the Twilio number, and branding.
- [x] Lifecycle: setting up (hidden from clients), go-live behind a checklist of required steps, temporary close with an end date and a public note, and archive. Archive is refused while anything is booked or open, and all history stays in reports.
- [x] Nothing in code names a location. Booking, the public site, the calendar, POS, reports and filters, permission scopes, location groups, Today and the digest all read shops from the database and respect status.
- [x] Self-service for the rest:
  - services and add-ons (already on Setup → Services);
  - staff onboarding, and offboarding that revokes access at once, takes the person off booking and schedules, and lists their booked appointments to move;
  - picklists;
  - client message wording with merge fields and preview;
  - block reasons, booking times and settings.
- [x] Test: `tests/db/locations.test.ts` creates a location through the wizard and finds it in booking, the calendar, POS, reports, permissions and groups. It then archives the location and checks that its history is kept. The owner's guide is in the README.
- [ ] Shops outside Central time: they can be saved but not opened until multi-time-zone support is built.

## 12. Today command center and the morning digest

- [x] **Needs attention** on Today, per shop and per permission. Most alerts have a one-click fix and a confirm step. The alerts:
  - open chair time, with a text to clients due for a cut;
  - no-show risk, with an extra reminder;
  - low stock, with a drafted purchase order;
  - time off waiting and call-in fallout;
  - regulars overdue to rebook, with a text;
  - barbers running behind, with a note to their next clients;
  - drawer variances;
  - unusual refunds, discounts and client lookups;
  - unconfirmed tax rates and setup checklist items;
  - sales against the same day last week, by shop;
  - failed messages, with a retry.
- [x] Extras: booked with a barber who's off, waitlist while chairs are open, drafts waiting to send, late deliveries, tickets left open, drawers never closed, a shop that can't take cards, and unread client texts.
- [x] Morning digest by email to the owner and managers. Replaced by the Morning Dashboard (section 24).
- [x] Tests: `tests/today.test.ts` and `tests/db/today.test.ts`.
- [ ] Marketing texts (open chair, rebook) wait on the marketing consent columns from PR #8. Until then the alerts say to call through the shop line. They now count toward the brand's marketing limits (section 21).

## 13. Per-location banking (Stripe Connect)

- [x] The owner picks a payments mode for each shop:
  - **Own Stripe account**: a connected account with its own bank, for a separate LLC.
  - **Brand account**: charges on the brand's Stripe account, paid out to the brand bank.
  - **Cash only**.
- [x] The Add Location wizard has a **Payments and banking** step, and its done screen opens Stripe-hosted onboarding (Account Links). Stripe collects the legal entity, EIN, owner identity and bank. The app stores only the Stripe account ID and what Stripe reports: charges enabled, payouts enabled, requirements due and the payout schedule. A test fails if a bank, SSN or EIN column ever appears.
- [x] The go-live checklist blocks until Stripe enables charges on the shop's own account, unless the owner picks cash only. A brand-account shop is ready at once.
- [x] Per-location settings:
  - the statement descriptor (as `RAYZ* SUFFIX` on the brand account);
  - the payout schedule, read from Stripe;
  - the card fee and tipping presets;
  - Terminal readers registered by code to the shop's own Terminal Location;
  - receipt branding.
- [x] Every charge, tip, gift card sale and Terminal payment goes to the right account through `chargeRoute`. Cash-only shops are refused, and POS only offers the shop's own readers. Refunds follow the account the payment settled in, even after a mode switch.
- [x] Both webhooks are location-aware:
  - the platform webhook handles dashboard refunds, disputes and the brand account's payouts;
  - the Connect webhook handles account and capability updates, bank changes, deauthorization and payouts.
- [x] Reports and payouts reconcile per shop:
  - Shop P&L covers brand-account shops;
  - the **Payouts** page works per shop and brand-wide, with fees and refunds;
  - Today flags failed payouts.
- [x] Only the Brand Owner, or someone they've granted `payments.banking`, can choose the mode, onboard, open the Express dashboard or change the descriptor. Every change is audited.
- [x] Tests: `tests/banking.test.ts` and `tests/db/banking.test.ts` cover charge routing, refunds, webhooks and go-live gating.
- [ ] Try it in real Stripe test mode with Connect test accounts. The four Stripe keys aren't set yet, so the simulator runs.
- [ ] Collecting a payment on a real reader (`processPaymentIntent`) is simulated. Registering readers and Terminal Locations calls Stripe when keys are set.
- [ ] Embedded Connect onboarding isn't used. Stripe-hosted Account Links are, which need no client-side Stripe.js.

## 14. Time clock and hours tracking

The owner reversed the earlier "no clock-in" decision: everyone is paid hourly.

- [x] Clock in and out and breaks, from a phone (`/admin/clock`) or the shop's front-desk device with a personal PIN (`/admin/clock/kiosk`). Every punch is tied to its shop; multi-shop barbers pick the shop they're at.
- [x] Anti-buddy-punching per shop: a registered device, GPS within a geofence, or the shop's network (IP or CIDR). There's an optional or required photo. The method, location, distance, IP and device are recorded on every punch.
- [x] Rules and alerts:
  - forgotten clock-outs are flagged, emailed to managers and shown on Today;
  - clocking in during time off gives a warning;
  - late, early and stayed-late are flagged against the schedule, with configurable grace minutes;
  - overtime is weekly over 40 (FLSA), and configurable;
  - unpaid meal breaks are configurable.
- [x] Timesheets per day, week and pay period (bi-weekly, ending Saturdays, anchored 2026-10-03), showing scheduled against actual hours:
  - manager edits need a reason and are logged with before and after;
  - the employee signs off, then a manager approves;
  - the period then locks.
- [x] Full time and part time: rolling average weekly hours over 4, 8, 12 or 13 weeks against the 32-hour line, with alerts on crossings.
- [x] Payroll export per period, employee and shop: regular, OT and break hours, card and cash tips, and service and product sales. It comes as a generic CSV and an iSolved-friendly CSV, with configurable columns. Nothing connects to iSolved.
- [x] Reports:
  - **Labor hours and cost**: hours, cost, labor % of sales and sales per labor hour, with rates behind `payroll.rates`;
  - **Attendance**: late, early-out, missed punches, forgotten clock-outs and no-shows.

  Both work for one, several or all shops and barbers.
- [x] Permissions, à la carte: `timeclock.punch`, `timeclock.kiosk`, `timesheet.own`, `timesheet.edit`, `timesheet.approve`, `payroll.rates` and `payroll.export`.
- [x] Tests: `tests/time-clock.test.ts` and `tests/db/time-clock.test.ts`. They cover pairing, breaks, overnight and DST, overtime math, the rolling 32-hour calculation, edits and the audit log, the period lock and the export totals.
- [x] The calendar follows the clock in real time. In each barber's day column:
  - a status badge: Clocked in, On break, Clocked out or Not in yet;
  - worked time beside the scheduled shift;
  - flags for a late clock-in, a start passed with no clock-in, an early clock-out and a missed punch.

  The calendar checks every 15 seconds and redraws without a reload.
- [x] Clock events create real calendar block-outs (`time_blocks`, source `clock`), not an overlay:
  - [x] Starting a break blocks out from now with Break or the reason picked, for the planned length if there is one, otherwise the shop's default, and on past that while the break lasts.
  - [x] Clocking out before the scheduled end blocks out "Clocked out" from the clock-out to the end of the shift.
  - [x] "Not in yet" before the clock-in, as a softer shade. A shop setting, off by default.
  - [x] Clocking back in or ending the break trims the block to the actual time.
  - [x] Same block model, shading, reason colors, reason privacy and permissions as manual blocks.
  - [x] They remove availability, online and at the desk.
  - [x] They drive the affected-appointments alert and the rebook flow (a call-in on the block itself).
  - [x] They show in who's off, who's blocked and **Reports → Who's working, off and blocked**.
  - [x] Marked as from the time clock and linked to the punch: editing, adding or voiding a punch moves, trims, reopens or removes the block.
  - [x] Managers can change, remove or reset them, and each override is in the audit log. Barbers can't change or remove them.
- [x] An early clock-in opens earlier slots, if the shop and the barber both allow it. Clients see only the open times.
- [x] Clients booked in a clock block are flagged on the calendar and Today, and managers are emailed once.
- [x] A barber not clocked in X minutes before their first appointment (10 by default) alerts the managers on Today and by email.
- [x] Today's who's-in list, open chair time and waitlist alert use the actual clock status.
- [x] Tests: `tests/clock-live.test.ts`, `tests/clock-blocks.test.ts`, `tests/db/clock-live.test.ts` and `tests/db/clock-blocks.test.ts`. They cover creating, trimming and linking blocks to punches (edits, adds and voids), overrides and their audit, availability, the late clock-in alert and flagging affected clients.
- [ ] To confirm with the owner or accountant:
  - [ ] Iowa and Illinois overtime rules. It's federal weekly-over-40 for now, and daily OT is available as a setting.
  - [ ] The exact iSolved import template: column headers and earning codes. Edit them under **Time clock setup**.
  - [ ] Meal and rest break rules: 30 minutes or more is unpaid by default, and the automatic meal deduction is off.
  - [ ] Each shop's exact coordinates, geofence radius and public IP. The seeded coordinates are approximate.
  - [ ] Which shops require a photo, and which check each shop uses. Only Coralville is set up in the demo.
  - [ ] How long a break with no planned length should block (30 minutes by default), whether any shop wants "Not in yet" blocks, the not-clocked-in alert lead time (10 minutes), and whether any shop wants early clock-ins to open slots.
- [ ] The mobile app has no clock-in yet. The interface for adding one is in NOTES-SYNC.

## 15. Tip payouts to employees

- [x] A tip ledger per employee, shop and ticket: card, cash and gift card tips. Refunds and voids reverse the tip (with its share of the card fee), and manager adjustments are their own entries with a reason. The ledger is append-only.
- [x] Card tips show Pending settlement, Available, In a payout and Paid out. They become available once the shop's delay has passed since the sale; cash tips at once.
- [x] Optional card fee netting on card tips, per shop, off by default, with a warning that it needs the accountant or a lawyer.
- [x] Payout schedule per shop, within the brand's allowed methods: end of night at drawer close, daily on a delay of N days, weekly, with payroll only, or manual.
- [x] Methods:
  - [x] Cash from the drawer at close: a cash payout record, deducted from the drawer's expected cash, acknowledged by the employee with their clock PIN or name on the device. The drawer can't close while one is waiting.
  - [x] Stripe Connect recipient accounts for staff with no Stripe Dashboard, through Stripe's embedded onboarding (the hosted page as the fallback; no bank details in the app; see My banking below and section 49). Transfers come from the shop's Stripe balance (or the brand's), with instant payout where eligible and its fee shown.
  - [x] Payroll export only.
  - [x] Each employee chooses, if the brand allows it.
- [x] Managers review and approve every batch, with each employee's breakdown by ticket. Hold, adjust, take out and cancel need a reason and go in the audit log; nobody adjusts their own.
- [x] The same tip can't be paid twice: claims under row locks, a database trigger, unique indexes and Stripe idempotency keys. History before tip payouts is recorded as already paid.
- [x] Reconciled against Stripe (`payout.paid`, `payout.failed`, `payout.canceled`, `transfer.reversed`, `account.updated`) and against the cash drawer. A failed payout reverses the money and puts its tips in the next batch.
- [x] Permissions: `tips.own`, `tips.approve` and `tips.settings`.
- [x] **My banking** (`/admin/my-banking`):
  - [x] Employees add or change their bank account or debit card with Stripe's embedded components in the staff app (onboarding and account management through an Account Session; the hosted Account Link is the fallback). Barbers have no Stripe Dashboard. Stripe collects identity, tax and bank details. The app keeps only the Stripe account id, its status, and the type, bank or card name and last 4 that Stripe returns.
  - [x] Status: not set up, pending verification, ready or action needed, with what Stripe needs in plain words and its deadline.
  - [x] The employee is told when Stripe needs more information, once per new request.
  - [x] A change of payout destination or method sends a security notice (email and text) and goes in the audit log.
  - [x] Managers see only the method, status and last 4.
  - [ ] Stripe's embedded account onboarding and management components aren't used; the hosted pages do the same job without another frontend dependency. Say if the embedded ones are wanted.
- [x] **My tips**: today, pending, ready, in a payout, paid out and history. The employee is emailed (or texted) when a payout is sent or fails.
- [x] Every tip still flows into the pay period's payroll and iSolved file. Tips paid in cash or by Stripe go out as tips received (`E_Cash Tips Recd_Dollars`), so they're reported but not paid again; tips paid through payroll get their own column and are locked as paid at approve-and-lock.
- [x] **Reports → Tip payouts** by shop and employee.
- [x] Tests: `tests/tips.test.ts`, `tests/banking-status.test.ts`, `tests/db/tips.test.ts` and `tests/payroll-engine.test.ts` cover ledger math with refunds, delayed availability, double-payout prevention, the cash drawer deduction, the Stripe transfer and payout webhooks, the banking status flow and the payroll export with tips already paid.
- [ ] To confirm with the accountant or a lawyer: whether the card fee may be taken out of card tips in Iowa and Illinois, and how it's reported. It's off at every shop.
- [ ] To confirm with Charles: the iSolved earning code for tips paid through payroll. It's `E_Tips Paid In Payroll_Dollars` for now, a setting under **Payroll → Setup**, and the column only appears when someone is paid that way.
- [ ] Each shop's schedule, delay and method. The demo sets Coralville to end of night in cash and Moline to daily, two days after the tip; every other shop is manual in cash.
- [ ] Try staff onboarding and payouts in real Stripe test mode. The keys aren't set, so the simulator runs. The Connect webhook needs the payout, account and `account.external_account.*` events for staff accounts, and the platform webhook needs `transfer.reversed` (see DEPLOY.md).
- [ ] Instant payout fee: Stripe's rate is set with `TIP_INSTANT_FEE` (default 1.5%, at least $0.50). Confirm it against the platform's Stripe pricing.

## 16. Processor-hosted data (the business never holds financial or identity data)

- [x] Bank accounts, debit cards, SSNs and TINs, EINs, dates of birth for identity checks, ID documents and card numbers, for employees, shops and clients, are collected only on Stripe's surfaces: Connect onboarding, the embedded components and the shops' Express dashboards, the Payment Element and Terminal. No page has a field for them, which a test checks.
- [x] The database, logs, audit log and backups keep only Stripe IDs, statuses, last 4 and bank or brand names:
  - [x] No column or JSON property for those values; a test greps the schema, every migration and the live database.
  - [x] Every `console` call in the server and the worker is scrubbed (`src/instrumentation.ts`), as are audit details.
  - [x] A trigger in the database scrubs every free-text column on write, for every writer (`core_0035_scrub_sensitive`). Existing rows were scrubbed once.
  - [x] Backups copy the scrubbed database.
- [x] Log and error scrubbing: error messages, stacks, causes and properties too.
- [x] Tests: `tests/sensitive.test.ts`, and `tests/db/sensitive-data.test.ts`, which plants values through webhooks, notes, texts, imports, queued messages, audits and a failing action. It then greps every table, JSON column, log line, webhook response, banking view, `/api/v1` GET response and the OpenAPI document.
- [x] PCI SAQ A: keyed cards only through the Payment Element (cards only), card-present only on Terminal readers, and a Stripe-only CSP on production checkout pages.
- [x] Tax forms: Stripe Connect tax reporting handles 1099s for connected accounts. Shops' forms are in their Stripe dashboard; employees' tips are W-2 wages, so their accounts are left out (DEPLOY.md). Notes on Location setup and My banking.
- [x] README: [What we store and what Stripe stores](README.md#what-we-store), for staff.
- [ ] Turn on Stripe tax reporting for connected accounts in the Dashboard (DEPLOY.md), and have the accountant confirm 1099-K for shops on their own accounts and no 1099 for employees' tip accounts.
- [ ] Confirm the SAQ type under Stripe **Dashboard → Settings → Compliance** once live, card readers included.
- [ ] Database backups and point-in-time history from before `core_0035` ran keep the old rows until they age out (Neon's restore window). The demo data never held real numbers.
- [ ] Bare digit runs that aren't card numbers (a 9-digit SSN or routing number without dashes, a bank account number) can't be detected in free text. The control is that nobody asks for them; the scrubbing is a backstop.
- [ ] No error tracker or analytics is installed. If one is added, its `beforeSend` must run events through `scrub()` (DEPLOY.md).

## 17. Sign-in restrictions per location (network and devices)

- [x] Each location has an allowed-IP list of single IPs and CIDR ranges (IPv4 and IPv6), with **Use my current IP** and an on/off switch. It's on **Setup → Sign-in security**, Shop settings and the Add Location wizard. Ranges wider than /16 (IPv4) or /32 (IPv6) are refused, and the editor warns before you lock yourself out.
- [x] With the restriction on, that location's staff and shop logins only sign in and stay signed in from an allowed IP. That covers the POS, calendar, time clock, client data and every other admin page, action and download. It's enforced server-side in the middleware on every request, again in `getStaffContext`, and at sign-in.
- [x] Client IP only from a trusted proxy: `x-real-ip` on Vercel, `TRUSTED_PROXY_HOPS` entries from the end of `x-forwarded-for` self-hosted, otherwise unknown and refused. The time clock's network check uses the same reading.
- [x] **Can access remotely** (`access.remote`) exempts roles, roles at one shop, or people. By default only Brand Admin has it, and the Brand Owner is always exempt.
- [x] Optional trusted devices: a blocked sign-in asks for approval, and a manager (`devices.approve`) or the brand approves it, never their own request. The browser gets a signed, `httpOnly` 400-day cookie, of which the database keeps only a hash. Revoking it takes effect on the next request. Each location requires an allowed IP, an approved device, either or both.
- [x] Every blocked attempt is in the audit log (`network.blocked`, with who, IP, time, location, what was missing and the page) and on **Sign-in security**. An optional email alert goes to the brand, on by default, at most hourly per person and location.
- [x] The block message: "Sign-in is only allowed from the shop." It appears on sign-in, after a blocked session is signed out, and in the 403 from actions and downloads.
- [x] Someone with several shops keeps the ones they can reach. A brand-wide manager away from one restricted shop loses brand-only permissions until they're back.
- [x] Tests: `tests/network-access.test.ts` and `tests/db/network-access.test.ts`. README: [Sign-in restrictions](README.md#sign-in-restrictions).
- [ ] Each shop's real public IP and whether its provider keeps it static. Every shop starts with the restriction off.
- [ ] Who besides Brand Admin gets **Can access remotely**, for example managers who do schedules from home.
- [ ] The mobile app has no staff sign-in, so there's nothing to restrict there yet. NOTES-SYNC says how to apply it if staff endpoints are added.

## 18. Customer screen at checkout (hand to customer)

- [x] **Hand to customer** on the POS switches the device to a full-screen customer view: the shop's logo, the itemized total (items, discounts, tax, tip, gift card), the tip buttons, custom and no tip, and the credit card surcharge disclosure.
- [x] Tip buttons in percent or dollars, up to 4, with custom and no tip each on or off: set for the brand (`handoff.settings`, brand-only) and overridden per location in Shop settings and the Add Location wizard. Percent buttons are also the counter's quick tips.
- [x] Then the signature (optional per location), the receipt (text, email or none, on file masked or typed once), and payment on the Stripe Terminal reader, by card in Elements, or the test cards in the simulator. Cash sends the device back to the counter with the tip.
- [x] While handed over, staff navigation, the back button, client data and every other page are unreachable: the middleware redirects every page to the ticket's screen and refuses every other action, and the staff session can't be used. The screen's own actions only work for that ticket on that device.
- [x] Staff take it back with a staff PIN or, where the location asks for it, a manager's PIN (`handoff.unlock`). Wrong PINs count toward the time clock lockout. After payment, "Thank you, please hand the device back" returns it by itself after 3 to 60 seconds, or waits for a PIN, set per location. **End hand-off here** on another device ends it if the device walks off.
- [x] Tips on the Stripe Terminal reader as an alternative per location: the screen skips its tip step and the reader asks. The location's first three buttons are pushed to the reader's Terminal configuration.
- [x] Tips flow into the tip ledger, tip payouts and reports for the assigned barbers. With several barbers on a ticket, a barber per line, and the tip split by services or evenly in whole cents, including tip refunds, in the ledger, Barber performance and the payroll report.
- [x] iPad and phone, portrait and landscape: the summary moves from the top to a left column; buttons at least 56 px; safe areas respected; locked to that ticket.
- [x] Tests: `tests/handoff.test.ts` and `tests/db/handoff.test.ts`. README: [Customer screen at checkout](README.md#customer-screen-at-checkout).
- [ ] Taking the card on a real Stripe Terminal reader is still simulated (as at the counter), so the reader's tip is read from the simulated reader. With real readers, the tip comes back on the PaymentIntent's `amount_details.tip`, which isn't wired yet.
- [ ] Guided Access (iPad) or screen pinning (Android) still helps: the lock covers the app, not the home button or other apps. Worth a line in staff training.
- [ ] Whether the brand wants signatures on by default (off until a location turns it on), and its tip buttons (20/25/30% today).

## 19. Digital receipts

- [x] Receipts are digital only: **Text** (a link), **Email** or **No receipt**, at the counter right after paying and in the customer screen's receipt step. Paper isn't offered: the ticket's Print button only shows where a shop turns on **Show a Print button** (off by default).
- [x] The phone or email on file is offered first. Staff whose **Client data** settings mask or hide it see it masked (`***-***-1234`, `j***@example.com`) and can still send to it, or type the one the client gives.
- [x] A branded receipt page for phones per link: the shop's logo, name, address and phone, the itemized services and products, discounts, tax, tip, the credit card surcharge and disclosure, the payment method (card brand and last 4 only), the barber's first name, loyalty progress, **Rebook** (same barber and service) and **Leave a review** (the shop's review link). No last name, phone or email on the page; each link's token is stored only as a hash; not indexed.
- [x] Refunds and voids, from the POS or a Stripe dashboard refund, send an updated receipt to where the client chose for that ticket. The page always shows the ticket as it is now, with the refund and the net paid. A failed update never blocks the refund and is recorded as not sent.
- [x] Staff resend from the ticket's receipt card or the client's purchases, with the history of every receipt (when, where, why, by whom, delivery status). Clients ask for copies at `/receipt` with their number or email: links to their last 3 receipts in 13 months, the same answer whether or not they're a client, at most 3 an hour per destination.
- [x] Consent: STOP (`contact_opt_outs`) and **Stop receipt and review emails** are always respected; updates and resends to what's on file need the client to have chosen it for that ticket or to have opted in (`sms_opt_in`, `email_opt_in`). Texts end with "Reply STOP to opt out." Core only reads the consent the mobile side owns.
- [x] Audit: `receipt.sent`, `receipt.none`, `receipt.resent`, `receipt.requested`, `receipt.email_opt_out`.
- [x] Tests: `tests/receipts.test.ts`, `tests/db/receipts.test.ts`, and the receipt step in `tests/db/handoff.test.ts`. README: [Digital receipts](README.md#digital-receipts).
- [x] Each location's review link under **Shop settings → Receipts**; without one there's no **Leave a review** button. It's Google only now (section 20).
- [ ] Receipt texts go out under the shop's A2P 10DLC campaign; confirm the campaign's use case covers transactional receipts.
- [ ] Whether **Stop receipt and review emails** should also stop other transactional emails (it covers receipts and Google review requests today), and whether the brand wants paper available anywhere.
- [ ] Imported Squire tickets have no digital receipt (not offered, not in copy requests).

## 20. Google reviews

- [x] **Leave a review** on the digital receipt links to the location's Google review page. The link is set per location in **Shop settings → Receipts** and in the new location wizard: a `g.page/r/…` link, a `search.google.com/local/writereview?placeid=…` link, or a Place ID (turned into the write-review link). Other sites are refused; blank hides the button.
- [x] Optional follow-up text or email a set number of hours after the visit (default 3, 1 to 48), per location, off by default. Only to clients who agreed to texts or emails; STOP and **Stop receipt and review emails** win; not in quiet hours; once per ticket and at most every 90 days per client per location (configurable).
- [x] L47: the follow-up goes to the app first, as a push, when the client (or a child's parent) has app notifications on; tapping it opens the same tracked review link (`data.kind: "review_request"`, `data.url`). Otherwise it's a text or email as above. `tests/db/review-push.test.ts`. Migration `core_0133_push_data`.
- [x] No review gating: ratings, tips, refunds and complaints aren't looked at, and everyone who gets the link gets the same link and message. Only voided tickets (rung up by mistake) and imported tickets are skipped.
- [x] The button and the follow-up only from the client's 3rd completed visit (checked out; cancelled, no-shows and voided tickets don't count), counted across all locations. A brand setting (**Shop settings → Google reviews**, default 3) that each location can override under Receipts.
- [x] After a client taps a location's link, that location doesn't show or send it to them again for 90 days (brand setting, per-location override). A tap is the signal because Google doesn't say who posted a review.
- [x] Clicks counted per location and per barber (the ticket's barber), from the receipt and from the follow-up, in **Reports → Google review links** with CSV. Link previews and email scanners aren't counted.
- [x] Tests: `tests/reviews.test.ts`, `tests/db/google-reviews.test.ts`. README: [Google reviews](README.md#google-reviews).
- [ ] Each location's real link: in Google Business Profile, **Ask for reviews** gives the `g.page/r/…` link (or look up the Place ID).
- [ ] Review texts go out under the shop's A2P 10DLC campaign; confirm the campaign covers them (they're customer care, not marketing, but carriers may ask).
- [ ] Whether to turn the follow-up on, and the delay and repeat days per location.
- [ ] Asking only from the 3rd visit is based on loyalty, not satisfaction, so it isn't review gating as Google defines it, but Google's policy also discourages selectively soliciting reviews. Confirm the brand is comfortable with this, or set the visit to 1 to ask everyone.
- [ ] Whether the pause after a tap should cover every location (it's per location now, since each has its own Google listing), and whether walk-ins with no client on file should ever see the button (they count as a 1st visit).
- [ ] Google doesn't report which reviews came from the link, so the report counts clicks, not reviews.

## 21. Campaign Center

Called "Marketing / Engage" in the first request; renamed to the Campaign Center everywhere it shows.

**Name and permissions:**
- [x] Nav section **Campaign Center** (We have openings, Campaigns, Blasts, My lapsed clients, Settings), pages under `/admin/campaign-center`, the report **Campaign Center** at `/admin/reports/campaign-center`, the cron at `/api/cron/campaign-center`.
- [x] Permissions **Campaign Center: view / create / send / export** (`campaign_center.*`), a **Campaign Center** group in the role editor, and the report permissions `report.campaign_center.view` and `.export`.
- [x] Create and send are separate: create writes wording, coupons and blast drafts (with access to all shops, also the brand's version and Settings); send switches campaigns on or off and sends, schedules or cancels blasts.
- [x] Migration `core_0042_campaign_center` renames the old keys in roles and per-person overrides, keeping what each person could do.
- [x] Code-level names stay as they were (`src/server/marketing/`, `marketing_*` tables, the `marketing` notification kind). "Marketing" still appears in the UI where it means the legal category: marketing consent, marketing texts and emails.

**Coupons:**
- [x] Percent off, dollars off, or a free add-on, service or product (taken off at its price; online booking adds it for the client).
- [x] Rules:
  - services or products it applies to;
  - locations;
  - minimum spend before discounts;
  - start and end dates (by the ticket's day);
  - maximum uses in total and per client;
  - first visit only (walk-in tickets count as visits);
  - stackable or not, with other coupons and manual discounts.
- [x] One shared code, or single-use codes issued one per client by a campaign, with an optional validity in days.
- [x] Code and code type are locked once used.
- [x] Managers can only make or edit coupons for their own shops.
- [x] Redeemed in POS checkout. The ticket starts with the coupon held from online booking and any shared coupon set to apply automatically for the client.
- [x] Limits are re-checked under a lock inside checkout's transaction.
- [x] Refunds and voids give the use back.
- [x] Online booking has a coupon box, prefilled from the campaign link, and holds the coupon for checkout. Checks are rate-limited per client IP.
- [x] Loyalty: coupons lower net service spend, so loyalty is earned on what was actually paid for services.

**Automated campaigns:**
- [x] Ten campaigns, each switched on per location (off by default), with brand wording and per-location wording and settings:
  - birthday (7 days before);
  - we miss you (42 days);
  - win-back (90 days);
  - thanks for your first visit;
  - Nth visit milestone (10th);
  - no-show follow-up;
  - rebook reminder from the client's usual interval;
  - new barber or location to clients of nearby locations;
  - fill slow days (barber's next day under 50% booked, a coupon to their regulars);
  - finish your booking (unfinished online bookings).
- [x] Text, email and push templates with merge fields `{first_name}`, `{shop}`, `{barber}`, `{book_link}`, `{coupon_code}`, `{expiry}`, checked on save. Test send to yourself.

**Blasts:**
- [x] One-off text, email or push, sent now or scheduled, with a preview (counts per channel and sample first names) and a test send.
- [x] Segment builder filters:
  - location, barber;
  - last visit, visit count, spend;
  - services and products bought;
  - birthday month and rating (when client-data settings show them);
  - loyalty balance, tags;
  - opted-in channel.
- [x] Client tags on the client page (audited).

**Lapsed clients:**
- [x] Segment builder quick filters "last visit more than 2 / 3 / 4 / 5 / 6 / 8 / 12 weeks ago", custom days, and a between range in weeks or days (e.g. 3 to 4 weeks), with "nothing booked since" (cancelled and missed bookings don't count).
- [x] Combined with barber (the client's primary barber, most recent barber, or any visit with them), location and services or products. Primary is offered only when preferred barbers aren't hidden from the person.
- [x] A live count of matching opted-in clients before sending.
- [x] Lapsed sequences: up to six steps in one campaign (default 2 weeks reminder, 3 weeks with the booking link, 4 weeks coupon, 6+ weeks bigger coupon), each with its own wording and optional coupon, a per-step test send and live counts per step. Created off; create writes, send switches.
- [x] A client gets the step for how long it's been, once per lapse, and leaves the sequence once they book. A cancelled booking puts them back. "Stop after" (default 120 days) keeps old clients out.
- [x] Scoped per location and barber; each message signed with the client's barber's first name and a link to book with that barber (when they're bookable online there).
- [x] "We miss you" and win-back skip clients a sequence already wrote to since their last visit.
- [x] **Campaign Center: own lapsed clients** (off for barbers unless granted): a barber's own lapsed list by week bucket, first name and last initial only, and a send of **From your barber** through the engine (consent, quiet hours, caps, once per lapse), with a per-location switch and a daily limit (25 by default). Audited.
- [x] Report **Lapsed clients by barber**: lapsed clients by week bucket, lapsed messages sent, clients messaged, rebooked and the rebook rate, by barber and by campaign and step. Barbers with the report see only their own row.
- [x] Migration `core_0043_lapsed_campaigns`. Tests in `tests/marketing.test.ts`, `tests/db/marketing.test.ts` and `tests/db/tenant.test.ts`.

**Compliance and consent:**
- [x] Marketing consent is separate from appointment messages. It's read from PR #8's columns; nothing goes out until they exist.
- [x] Texts:
  - STOP, START and HELP on the shop line (HELP text in Campaign Center → Settings, or Twilio Advanced Opt-Out);
  - texts must say how to opt out.
- [x] Email:
  - one-click unsubscribe and the brand's postal address in every message;
  - no marketing email without the address.
- [x] Quiet hours, 9 PM to 9 AM in each location's time zone. Messages due then wait.
- [x] Frequency caps per client: 2 a week and 6 a month by default, including Today's texts.
- [x] Contact lists:
  - Staff see counts only.
  - Exports need **Campaign Center: export** (Brand Owner unless granted), follow client-data settings, and are audited.

**Reporting:**
- [x] Per campaign, location and barber:
  - sends, delivered, clicks;
  - bookings, redemptions, attributed revenue;
  - cost, ROI;
  - unsubscribes and the unsubscribe rate.
- [x] Attribution is last touch within 7 days (configurable). CSV export.

**Engine and tests:**
- [x] `/api/cron/campaign-center` every 15 minutes (Vercel Cron) and `pnpm worker`.
- [x] Idempotent sends: one row per client per occasion, under a per-client lock.
- [x] Providers are stubs in dev.
- [x] Tests: `tests/coupons.test.ts`, `tests/marketing.test.ts`, `tests/db/marketing.test.ts`. README: [Campaign Center](README.md#campaign-center).

**Still open:**
- [ ] Marketing consent columns from PR #8 (`sms_marketing_opt_in`, `email_marketing_opt_in`, `push_marketing`, `customer_devices`). The names are assumed until the mobile side confirms them, and the consent capture and TCPA wording are on the app side.
- [ ] Before any location turns a campaign on:
  - an A2P 10DLC campaign registered with a marketing use case;
  - the brand's postal address, under Campaign Center → Settings;
  - a real email account (Postmark broadcast stream or Resend, built; needs a key and a verified domain) and real push (Expo stub).
- [ ] Message costs for ROI are estimates set under Campaign Center → Settings (1¢ a text, 0.1¢ an email by default); replace them with the real rates.
- [ ] "Nearby" for announcements uses the shops' coordinates (clients of locations within the radius), since client addresses aren't used. The seeded coordinates are approximate.
- [ ] "Finish your booking" only knows about the website's booking flow. App bookings would need to call `saveBookingDraft` (NOTES-SYNC).
- [ ] Which campaigns to switch on, their wording and coupons per location.
- [ ] Whether barbers should get **Campaign Center: own lapsed clients** by default, and the lapsed sequences' steps, coupons and "stop after" per location.

## 22. Client search and segment filters

**1. Global client search** (client list, sidebar **Find a client**, calendar booking, POS, walk-in check-in):
- [x] Fuzzy names with typos on first, last, nickname and full name, in any order (pg_trgm word similarity).
- [x] Phone in any format or its last 4, email, client ID and number, loyalty QR card.
- [x] Birthday, address, city and zip, gift card, coupon code, ticket and appointment numbers, Squire ID, notes and tags.
- [x] Results show first name and last initial, nickname, last visit date and location, usual barber, photo, rating, masked phone, client number and what matched.
- [x] A returning walk-in is attached to the client found instead of creating a new record.

**2. Permission-aware search:**
- [x] A hidden detail is searchable only by its exact whole value, through a normalized SHA-256 lookup hash. Results never show it, and partial or prefix matches aren't offered.
- [x] A masked detail is searchable only by what the mask shows: phone last 4, zip and town, birthday month.
- [x] Every search is logged (where from, which kinds matched, how many, never the term). It counts toward the unusual-lookup alert and pause, which apply to everyone but the Brand Owner.
- [x] Partial terms reach only the searcher's clients. Whole identifiers reach any Ray'z client. Tickets and appointments are found only at the searcher's shops.

**3. Advanced filters** (the client list and Campaign Center segments share one set):
- [x] Visit history: last and first visit dates, ranges or days ago; visit count; no-shows; cancellations; average days between visits; upcoming appointment.
- [x] People and places: primary, recent or any barber; home and visited locations.
- [x] Spend: services and products bought, total and average spend, tips.
- [x] Loyalty and gift cards: loyalty balance, gift card status, coupons redeemed.
- [x] Profile: rating, tags (any, all, none), birthday month or upcoming, age range, zip, city, distance from a location, source, referral, created date.
- [x] Messaging: opt-in and marketing consent per channel, review link clicked, campaigns received and clicked.
- [x] Any field filled in or empty.
- [x] A filter that would read a detail the person can't see is refused with the reason.

**4. Saved searches and exports:**
- [x] Saved searches and segments: private, for a location, or for the brand (brand-wide staff only).
- [x] **Message these clients** opens a blast with the same filters.
- [x] **Export these** exports exactly what the search and filters list, for people with **Export the client list** (the Brand Owner unless granted). Audited with the search and filters.

**5. Duplicates:**
- [x] Detect-and-merge for imported Squire clients:
  - scored pairs, with conflicts kept apart;
  - an **Imported from Squire** filter;
  - **Not the same person**;
  - bulk merge that keeps the record with more visits, then the older one.
- [x] A merge moves every record that points at the client, including coupons, sends, unsubscribes, tags, the photo and referrals.

**6. Campaign Center and reports:**
- [x] In the brand portal. Brand Admins always have full access: every client detail at full and every location, plus the client-list, Campaign Center and report permissions. Shops and staff get what's granted per role and location.

**Profile additions:** client number, nickname, photo, source, referred-by, loyalty QR card.

**Still open:**
- [ ] Load the Census zip centers in production (DEPLOY step 14); the seed only has the demo shops' zips.
- [ ] Whether Brand Admins should get **Export the client list** by default. It stays Owner-granted for now.
- [ ] Photos are stored in the database (up to about 300 KB each, resized to 256 px in the browser). Move them to object storage if the book grows large.
- [ ] The customer app showing the loyalty card (NOTES-SYNC has the format).
- [ ] Scoring weights for duplicates are first guesses; tune them on the real Squire import.

## 23. Campaign Center permissions and We have openings

**1. Shop and location logins:**
- [x] By default a location (shop login, Front Desk, Shop and Regional Manager) has one Campaign Center action: **We have openings** (`campaign_center.openings`), first come, first served, per barber.
- [x] Pick one or several barbers; today or tomorrow by default (or up to 3 of the next 7 days); each barber's real open times from online booking.
- [x] Text and/or email to the barber's clients who agreed to marketing: regulars (2+ visits with them at the location in a year) and recent clients (a visit in the last 60 days), with nothing booked, plus an optional "last visit over N weeks".
- [x] The brand's template: "Hi {first_name}, {barber} at {shop} has openings {day}. First come, first served: {book_link}" ({shop} reads "Ray'z Coralville").
- [x] The link goes to the barber's live times; booked times disappear, and when the last goes it says **All booked, join the waitlist**. A time opens the booking page on that time.
- [x] Counts only: no names, phone numbers or emails, and no export.
- [x] Consent, quiet hours (9 PM to 9 AM; a send then waits), and at most one openings message per client per 7 days (brand setting), on top of the weekly and monthly caps.

**2. Reports and limits:**
- [x] **Reports → We have openings**: per blast, messages, clicks, bookings filled and fill rate, the waitlist; locations see their own, the brand all.
- [x] Per-location daily and weekly send limits set by the brand (defaults 3 and 12, each barber is one blast), and optional brand approval (approve, turn down with a note, withdraw, expire).

**3. Brand login:**
- [x] Coupons, automated campaigns, segments, blasts, exports, own lapsed clients and the marketing reports are brand-only by default. Migration `core_0045_openings` takes them out of the manager roles; the brand grants them back in the role editor or per person.

**Still open:**
- [ ] Whether managers at this brand should get any of the Campaign Center back (DEPLOY step 13).
- [ ] The waitlist text goes to everyone who asked, by text only, without marketing consent (they asked for it). Confirm that's the wanted reading for A2P.
- [ ] Open times are for the barber's most booked service; a client wanting a longer service may find the time too short and is sent back to pick another.

## 24. Morning Dashboard (email and page)

**1. Schedule:**
- [x] 7:02 AM Central by default, any minute from 4 to 11 AM under **Setup → Morning Dashboard email**; caught up until noon, never sent later.
- [x] No email on days every shop is closed (Sundays). Monday's covers Saturday, against the Saturday before (can be turned off to always cover yesterday).

**2. Recipients:**
- [x] Managed in the brand portal: by role (main role or a role at one shop), plus always or never per person.
- [x] Owner and brand team get the all-locations version; each shop manager gets their shop. Per person, the brand can switch to one email per shop, or both, and pick the shops.
- [x] À la carte: the new **Morning Dashboard** report decides who gets one at all, and each section needs its own report at each shop (sales, KPIs, barber performance, service times, loyalty, gift cards, Campaign Center or openings, Google reviews, staffing, attendance, labor, low stock, purchasing, tip payouts, shop accounts). Without "every barber's numbers", barber tables show only your own row.

**3. Content:**
- [x] Prior day with week to date and the same day last week: gross and net, services and products, tips, card fees, refunds and voids, by location and by barber.
- [x] Tickets, average ticket, new and returning clients, bookings made (online, walk-in, front desk), cancellations and no-shows.
- [x] Utilization per barber, and average cut time against booked.
- [x] Loyalty and gift cards; Campaign Center sends, clicks, bookings, redemptions and revenue; review link clicks.
- [x] Today: each shop's hours, who's working, open time per barber, time off and call-ins.
- [x] Exceptions: missed clock-ins and clock-outs, overtime risk (over 40, or a part-timer over 32), low stock, late and draft purchase orders, pending and failed tip payouts, approvals (time off, We have openings blasts, over-limit purchase orders), and Stripe payouts (failed, on the way, deposited).

**4. Format and delivery:**
- [x] Mobile-friendly HTML email with bar charts and links into the app, plus a plain-text part; the same dashboard in the app (`/admin/morning`) with PDF and CSV downloads.
- [x] Optional PDF attachment and optional one-line text, both off by default.
- [x] Idempotent: claimed per person, version and channel before it's built; overlapping runs and retries don't double-send.
- [x] Dev: with no email provider it's queued in the outbox and not sent; `NOTIFICATIONS_EMAIL_PROVIDER=console` logs it.
- [x] Tests: `tests/morning-dashboard.test.ts` and `tests/db/morning-dashboard.test.ts`.

**Still open:**
- [x] Resend and Postmark send the HTML part and the PDF (core_0081). Not yet tried against a real account.
- [ ] "Bookings made" counts appointments created that day by source; phone bookings entered at the desk count as front desk, since the app doesn't record a phone source.
- [ ] As in the KPI report, a client is new for a period when their first visit at those shops falls in it, so the week to date can show fewer returning clients than one day of it. With a short history (like the seed's) most of the week shows as new.

## 25. Custom report builder

**1. Building a report:**
- [x] Under **Reports → Custom reports**: pick a data source, then add or remove columns from a searchable, grouped field picker.
- [x] Customer fields: name, contact (phone, email, address, birthday; per Client data), city and zip, tags, staff rating, home location, primary barber, first and last visit, visits, average days between visits, total and average spend, paid tickets, services and products bought, tips, no-shows and cancellations, loyalty rewards available, gift cards and their balance, coupons redeemed, opt-ins, Campaign Center messages received and clicked, review clicks, source, client since, and every custom field.
- [x] Drag (or arrows) to reorder columns, rename headers, filter with the segment builder's filters, sort by up to three fields, group by up to two with subtotals, summary-only view, totals (sum, average, count, lowest, highest).
- [x] Date presets (or custom dates, or all time) and location and barber pickers, groups included.
- [x] **Sales** source, one row per paid ticket (refunded ones too): ticket, status, tenders, new or returning, imported, paid at, business day, weekday, hour, month, location, barber, client number, and the measures tickets, services, products, net sales (after refunds), discounts, tax, gift card sales, tips, card fee, total, refunded and items. Tickets link to the ticket.
- [x] **Appointments** source, one row per appointment: status, how it was booked, services, new or returning, any barber, family booking, cancel reason, start, day, weekday, hour, month, booked on, location, barber, client number, and the measures appointments, completed, no-shows, cancellations, booked minutes, lead days and estimate.
- [x] **Staff** source, one row per barber and location: role, active, main location, hire date, and over the dates appointments, completed, no-shows, cancellations, clients served, new clients, booked hours, clocked and overtime hours (as on the Labor report), utilization, service and product sales (as payroll counts them), sales per clocked hour, tickets, tips and rebooked at checkout. Needs **Barber performance**; hours, utilization and sales per hour also need **Labor hours and cost**.
- [x] **Inventory** source, one row per product and location: product, SKU, brand, category, sold here, on hand, reorder point, par, low stock, price, value at cost and retail, and over the dates received, sold, returned, transferred in and out, back bar, shrink and its cost, sell-through and product sales, as on the stock movement and sell-through reports. Needs **Inventory valuation**.
- [x] **Tips** source, one row per tip entry (a barber's share of a tip, a tip given back, an adjustment): left by, ticket, payout status and method, paid out on, reason, day, location, barber, amount and card fee share. Needs **Tip payouts**.
- [x] **Campaigns** source, one row per Campaign Center message sent: campaign, kind, channel, A/B wording, sent at, location, barber, client number, delivered, opened, clicked, bookings, revenue, coupons used, cost, unsubscribes and already booked, credited as on the Campaign Center report. Needs **Campaign Center**.
- [x] Dollar amounts on sales and appointments need **See dollar amounts in reports**, and each person's tips need **Tips and payroll export** (an event log tip shows no amount without it). A barber without **See every barber's numbers** gets only their own tickets and appointments.

**2. Saving and sharing:**
- [x] Save as a named report: only me, shared with roles, or a brand template (brand-wide builders).
- [x] Duplicate to edit someone else's report; the owner (or a brand-wide builder, for shared reports and templates) edits and deletes.
- [x] Scheduled email (daily, weekly, monthly, at a time), each recipient's copy run under their own access, with a CSV, Excel or PDF file when they may export it; once per report, person and day. Or show its totals in the Morning Dashboard.
- [x] CSV, Excel and PDF export, permission-gated and logged.
- [x] **Message these clients:** a customer report opens a Campaign Center blast with its filters, locations and barbers.

**3. Permissions:**
- [x] Hidden contact fields are greyed out in the picker with the reason; masked ones are shown masked and can only be counted.
- [x] Locations and barbers are cut to the person's access (and someone else's report to the person's locations); a Brand Admin or the owner covers every shop.
- [x] À la carte: open saved reports, build reports, export. A customer report export also needs **Export the client list**.

**4. Engine:**
- [x] One query built from a fixed SQL fragment per whitelisted field; definitions hold field keys only, values are bound parameters, no raw SQL. Totals and subtotals in the database, then a page of 50 (exports up to 25,000 rows).
- [x] Indexes on sales and appointments by client, and on clients by created date and preferred barber (`core_0047_report_builder`).
- [x] Tests: `tests/report-builder.test.ts` and `tests/db/report-builder.test.ts`.

**Still open:**
- [ ] Scheduled emails need the email provider's key set (Resend and Postmark are built).

## 26. Rayz Assistant

**1. What it does:**
- [x] A chat panel (**Ask Rayz**) on every staff page: brand portal, shop logins and the staff portal, including on phones.
- [x] Answers questions about sales by location or barber, comparisons, trends, utilization, lapsed clients, stock and purchase orders, tips, payroll hours and campaigns, plus "how do I…" help for 26 topics.
- [x] Tool calls over the report loaders and the report builder's engine, never raw SQL. Each answer shows the numbers with a link to the report.
- [x] A client list turns into a saved report (the builder opens with it filled in) or a Campaign Center blast segment.
- [x] Drafting a purchase order or a blast needs **Confirm** and the matching permission, checked again on confirm. A blast is only ever saved as a draft.

**2. Security:**
- [x] Runs with the asking person's permissions and location scope: tools, reports, locations and barbers are cut to theirs, and anything else is refused.
- [x] Fields Client data hides are never offered or included. Contact details, birthday, notes and custom fields never reach the model.
- [x] No card, bank or identity data is sent: questions and report text are scrubbed, and the app holds none anyway.
- [x] Every question, tool call, limit refusal and draft decision is audited. Limits are per person, per minute and per day.

**3. Provider:**
- [x] OpenAI or Anthropic by API key in the environment, or a keyword stub in development that runs without a key.
- [x] Brand Admin turns it on or off for each role (`assistant.settings`).
- [x] OpenAI requests use `store: false`. Zero data retention is requested per organization from OpenAI and Anthropic (DEPLOY.md step 17).

**4. Tests:**
- [x] `tests/db/assistant.test.ts` (permission and location scoping, hidden fields, drafts, audit, limits) and `tests/assistant.test.ts`.

**Still open:**
- [ ] Zero data retention has to be agreed with OpenAI or Anthropic for the brand's organization; the app can't turn it on.
- [x] The report builder's sales, appointments, staff, inventory, tips and campaigns sources have an assistant tool, `builder_report`, with the builder's source and field permissions (`tests/db/assistant.test.ts`).
- [ ] Answers aren't streamed; the panel waits for the whole reply.

## 27. Shop login parity with Squire, tighter

**1. Squire shop-login features and ours:**
- [x] Appointments side by side and week, block time, add appointment: the calendar's day and week views, blocks, quick walk-in.
- [x] Appointments **list view**: the calendar's **List** toggle (`/admin/calendar?view=list`), one day or seven, by barber and status (upcoming, completed, missed), names masked as on the calendar; a barber who can't see every column sees only their own (`tests/db/appointment-list.test.ts`).
- [x] Waiting list: Walk-ins & waitlist.
- [x] Clients list; locate duplicates (brand-only here, as merging changes every shop's records).
- [x] Retention report (quarter; visits to qualify 1/2/3; existing and new retention; lost to another barber or shop): **Client retention**.
- [x] Acquisition channels: **Acquisition channels**.
- [x] Staff list with clock in and out: the front-desk clock.
- [x] Services list.
- [x] Leaderboard (service and product sales, productivity, average ticket, new clients, tickets with product, top services, products and barbers): **Leaderboard**.
- [x] Gross, sales by service, product and barber, barber summary, commission, appointments, deposits, time track: the existing reports.
- [x] Saved reports: End of day, Tips, Iowa monthly and quarterly sales tax (one per state, on its schedule), gross and net, employee summary, total collected.
- [x] Register; cash drawer open and close with a $300 default and balance history.
- [x] Daily summary with reassign, receipt and refund.
- [x] **Custom charge** (an open-amount line): **Custom charge** on the register rings up a named service line from $0.01 to $1,000 for the ticket's barber; it needs `pos.custom_charge` (managers by default, not the front desk), the server checks it, and each one is audited as `sale.custom_charge` (`tests/db/register-permissions.test.ts`).
- [x] Gift cards.
- [x] Shop details, per-barber booking settings, waiting list.
- [x] Phone operator per shop with dollars booked, calls answered, book rate and minutes saved.
- [x] Customer handoff toggle.
- [x] Brand-only, as in Squire: inventory setup, marketing, payouts, location switching, adding barbers.

**2. Better than Squire:**
- [x] Client phone and email masked at most at the shop login, with no export, reveal or merge; the brand can hide them, and nobody can lift the cap (section 28).
- [x] Staff contact masked without `staff.contact`, including on save.
- [x] Refunds, voids and reassigning need a manager's PIN at the shop login, recorded on the record and in the audit log.
- [x] Shop settings gated per part, on the page and on the server.
- [x] A barber filter on every report with a barber in it.

**3. Tests:**
- [x] `tests/shop-login.test.ts` and `tests/db/shop-login.test.ts`; the new reports are in the report-total tests.

**Still open:**
- [ ] The phone operator is a keypad menu (book link, hours, ring the shop), not a conversational voice AI like Squire's Operator. It doesn't take bookings by voice.
- [ ] Existing shop logins have to be moved to the Shop Login role by hand (DEPLOY.md step 18).
- [x] `tests/db/flows.test.ts` "books, then refuses the same barber/time again" no longer depends on the time of day: it processes only its own booking's messages, at 11:30 pm, so other pending marketing jobs (which quiet hours defer instead of suppressing) can't fill the batch.

## 28. Client contact details stay in the system (owner's hard rule)

- [x] Shop logins and every shop or staff role (Regional Manager, Shop Manager, Front Desk, Shop Login, Barber, custom roles that aren't brand-level) never see a client's full phone, email or address: masked at most (last 4 of the phone), whatever a rule, an override or a reveal says. The brand can still hide them.
- [x] They never export or download a client list: client CSV, Campaign Center contacts, client ratings CSV, customer custom reports (download and email attachment), import skipped rows, the data-access log. Their audit log CSV leaves out client entries.
- [x] Not grantable: full contact rules and the client-list permissions are refused for shop and staff roles and their people, even from the Brand Owner, and stripped at runtime if they're in the database. The shop login cap has no "as the role allows" any more. (Revised by the owner: the brand can now make exceptions with contact access grants, section 29.)
- [x] Only brand-level people see full contact details or export: Brand Owner, Brand Admins, and people in a brand-level role the Brand Owner creates (**Brand-level role** on a custom role), with access to all shops, never a shop login.
- [x] Exact phone or email search still finds the client without revealing anything; calls, texts, reminders and openings blasts go through the system.
- [x] Enforced on the server: `contactCeiling` in every client policy, `clientListDenied` on every client-list download, `BRAND_LEVEL_ONLY` in `effectiveAccess`, `SHOP_LOGIN_NEVER` and the grant checks. Migration `core_0050_brand_level`.
- [x] Tests: `tests/db/client-contact-lockdown.test.ts` (every non-brand login given everything in the database, every download, reveal, search, the shop line, every grant path, and the brand-level side) and `tests/client-contact-lockdown.test.ts`.

## 29. Contact access grants (owner's revised rule)

- [x] By default shop logins and staff still can't see full client contact details or export client lists (section 28 unchanged for them).
- [x] Brand management grants it per location or per person, from **Setup → Client data protection → Contact access**, with separate grants for full contact details and for exports, an optional end date and a note.
- [x] Grants can be revoked at any time; revoked and expired ones stay listed with who gave and ended them. Every grant and revoke is audit-logged, and every export is in the client data access log and listed on the same page for the brand.
- [x] Only brand-level people with **Client data protection** can grant, and only what they hold themselves. A grant never counts as the holder's own when they give access to someone else.
- [x] Enforced on the server (`accessFor`, `seesFullContact`, `clientListDenied`). Tests: `tests/contact-grants.test.ts`, `tests/db/contact-grants.test.ts` (default and granted cases, per person and per location, revoke, expiry, who may grant), and the lockdown tests for the default.

## 30. Self-serve brand portal users

- [x] **Setup → Users**: invite (email with a single-use 7-day sign-up link, stored hashed), add, edit, deactivate, reactivate and remove brand and management users; resend or cancel an invite.
- [x] Optional two-step sign-in requirement per user (authenticator app, RFC 6238), with set-up at sign-up or the next sign-in, reset, replay protection and a lockout after 5 wrong codes.
- [x] A role or custom permissions per user: role templates across every module plus per-person permissions on top; location scope all or selected. Role templates (Brand Owner, Regional Manager, Shop Manager, Front Desk and custom ones) are edited and created by the owner.
- [x] Remote access (exempt from the shop sign-in restriction) is a per-user switch.
- [x] Can't be locked out: the last Brand Owner who can sign in can't be deactivated, removed or demoted; nobody changes their own account or gives permissions they don't hold; someone with upcoming appointments isn't deactivated or removed until they're moved.
- [x] Every change is audit-logged (`user.*`, plus the existing role and access entries), with each user's account history on their page.
- [x] Tests: `tests/users.test.ts`, `tests/db/users.test.ts`. Migration `core_0051_user_admin`.

**Still open:**
- [ ] Until Resend or Postmark is set up (DEPLOY.md step 25), the invite link is shown to the inviter to pass on.
- [ ] Changing `AUTH_SECRET` makes stored authenticator keys unreadable; those users need their two-step reset.

## 31. Time between visits

- [x] On the staff client profile (any shop or brand login) and the customer's own account page: the average time between visits as "Every 3.5 weeks" (days under two weeks), from completed visits, shown from the second visit.
- [x] Robust to one-off long gaps: the median of the last 10 gaps between visit days; two appointments on one day count once.
- [x] Last visit, days since, next expected visit (last plus the average) and a status badge: on track, due (from 3 days before), overdue (a week, or a quarter of the gap, after). Booked clients are on track.
- [x] Per barber on the profile and the account page when they've seen more than one.
- [x] Client list column (and CSV export), filters on the client list, Campaign Center segments and the report builder (usual days between visits; on track, due, overdue), report builder fields (average, comes in, days since, next expected, status), scoped to the report's barbers.
- [x] Rebook reminders at the average less the campaign's lead days (3 by default); Today's rebook and open-chair lists use the same average.
- [x] In the assistant's queryable fields, with status and days-between-visits filters.
- [x] Tests: `tests/visit-cadence.test.ts`, `tests/db/visit-cadence.test.ts`.

**Still open:**
- [ ] The account page reads only the latest 20 past appointments, because `/api/v1` belongs to the mobile agent; the request to return the full cadence from `/me` is in NOTES-SYNC.

## 32. Client retention badges

- [x] Shown on the client profile, calendar blocks (and the appointment drawer), checkout/POS, the client list and search results, each with an icon, a colour and a tooltip that says why.
- [x] Visit timing: on track, due, overdue (from the time between visits), lapsed (over N weeks), at risk (last gap stretching against their norm).
- [x] New and returning: new client, 2nd visit, win-back.
- [x] Value: VIP (top X% of spend), loyal regular (N+ visits), reward ready, gift card balance, coupon.
- [x] Celebrations: birthday this week, birthday this month, anniversary.
- [x] Booking behavior: no-show risk, late cancels, always books with {barber}, switched barbers, books online.
- [x] Barber change: barber left.
- [x] Feedback and products: low rating, review clicked, product buyer, never bought product.
- [x] Profile and marketing: missing info, opted out, referral source, referrer.
- [x] Brand portal: on or off per badge and overall, every threshold, custom badges from any segment-builder filter, and which roles see which badge. Sensitive and money badges are brand-controlled.
- [x] Badges never reveal hidden contact fields or other hidden details; tooltips carry no contact details.
- [x] Badge filters on the client list, in the report builder (and a column) and in Campaign Center segments.
- [x] Morning Dashboard counts of today's booked clients by badge; Today highlights action badges (2nd visit, birthday, at risk, reward ready) and counts them.
- [x] Computed nightly (incrementally, in batches with a time budget) and on checkout, and cached.
- [x] Tests: `tests/badges.test.ts`, `tests/db/badges.test.ts`.

**Still open:**
- [x] Staff badges in the staff app: `GET /api/staff/v1/appointments/{id}` returns the client's badges through `shownBadges` (section 34).

## 33. Customer-facing badges (gamified)

- [x] Each badge has a staff-only or customer-visible setting in the brand portal (Setup → Client badges, **Customers see**). Staff judgments built on ratings can never be shown.
- [x] Customers see their customer-visible badges in their account and on the booking site (when signed in), with the badge id, name, icon, colour, earned date and progress toward the next.
- [x] Customer-visible by default: Gold, Silver and Bronze (visits with no no-shows, all thresholds settable), We miss you (8+ weeks, settable; clears when they book; Book now), Birthday, Anniversary, Reward available, Streak (5 kept on time in a row), Referral champion, Reviewer.
- [x] Staff-only by default: No-show risk, Late cancels, VIP, Low rating, Missing info, At risk, and every other badge.
- [x] Messages when a customer earns or loses a badge, chosen per badge, through the Campaign Center (Badge news): marketing consent, the brand's caps plus one per N days, quiet hours.
- [x] Progress meters ("2 more visits to Gold").
- [x] Tests for the visibility rules: `tests/customer-badges.test.ts`, `tests/db/customer-badges.test.ts`.

**Still open:**
- [ ] `/api/v1/me/badges` and its OpenAPI entry: the handler and the OpenAPI fragment are ready (`src/server/customer-badges-api.ts`, `CUSTOMER_BADGES_OPENAPI`). The mobile agent owns `/api/v1` and `openapi.ts`; the request is in NOTES-SYNC. Until it's mounted, the same endpoint is at `/api/account/badges`.

## 34. Staff mobile app API (replaces Squire Commander)

Charles's scope: a staff namespace at `/api/staff/v1`, apart from the customer `/api/v1` (the mobile agent's), with roles and permissions enforced on the server. The Rayz App builder is auditing Squire Commander and will send the API gaps. README "Staff app API" and NOTES-SYNC "Staff app API" have the contract.

- [x] Staff sign-in apart from the customer phone code: email and password, the authenticator step, rotating refresh tokens (reuse ends every session), sign-out. Inactive, offboarded and signed-out-everywhere people are refused, and location sign-in rules apply.
- [x] Roles and permissions on the server for every request, from the same staff context as the web: role, overrides and their expiry, shop scope and per-shop roles. Shop logins get the front-desk clock only.
- [x] My schedule (hours, time off, blocks) and my appointments. Others' appointments are not found unless they can see every barber's calendar.
- [x] Client notes for my appointments, filtered by the notes permissions (private manager notes need their own permission), each read logged.
- [x] Time clock (S2) with the front-desk QR code, the NFC sticker, Wi-Fi or location, or the front-desk tablet with each person's PIN. No biometrics.
- [x] Breaks with a reason and a planned length.
- [x] My tips, earnings and payout history (S3). Each earnings part (sales, tips, commission) follows its own permission.
- [x] Stripe-hosted bank account and debit card onboarding and dashboard links. Only the Stripe account id, status and last 4 (with type and bank or brand name) are kept.
- [x] Milestone pop-ups, a clock-in reminder and an open shift pop-up; congratulations seen in the app don't show again on the web.
- [x] Push to the barber's phones for their own new, changed and cancelled bookings (staff phones, their own APNs topic).
- [x] OpenAPI document at `/api/staff/v1/openapi.json`. Migration `core_0099_staff_app`. Tests: `tests/db/staff-api.test.ts`.

- [x] The Rayz App builder's gap list and the app version gate: see section 37.

**Still open:**
- [x] L36: approved-device sign-in for the app. A blocked sign-in gets a 15-minute ticket to ask for approval (`POST /auth/device/request`); the app sends the device token as `X-Device-Token`, and it counts on sign-in and every request once a manager approves it under Sign-in security. `tests/db/staff-app-device.test.ts`. The app's screens are the Rayz App builder's.

## 35. Staff app Stripe tip payouts (matches Squire Commander)

Charles's scope: each employee gets their own Stripe Connect account, separate from the shops' accounts, set up from the staff app (a recipient account with no Stripe Dashboard and embedded onboarding since section 49). Stripe test mode only. README "Tip payouts" and "Staff app API", and NOTES-SYNC "Tip payouts", have the details.

**On (2026-10-27), with section 36:** Charles decided card tips go straight to employees' banks through Stripe, so `FEATURE_STAFF_STRIPE_PAYOUTS` defaults on (`false` switches it off). The W-2 safeguards are section 38.

- [x] Staff API: start or resume onboarding (`POST /banking/onboarding-link`, with the step: start, resume, update or done), account status and requirements (`GET /banking`), the external accounts with last 4 only (`GET /banking/external-accounts`), and `POST /banking/dashboard-link`, now 409 outside the simulator (no Stripe Dashboard, section 49).
- [x] Onboarding covers identity, the bank account and a debit card for instant payouts, all on Stripe's pages.
- [x] Manager-approved payouts move from the shop's connected account (or the brand's, for brand-account shops) to the employee's account with separate charges and transfers, then pay out on the shop's schedule.
- [x] Standard payouts to the default bank or card, and optional instant payouts to the debit card. Without an instant-capable card it falls back to standard and says so in the audit log.
- [x] Brand setting for the instant fee: passed on to the employee (default) or paid by the shop. Each payout records who paid it.
- [x] Webhooks: `account.updated`, `payout.paid`, `payout.failed` (plus `account.external_account.*`, `payout.canceled` and `transfer.reversed`). A failure reverses the transfer, refunds the shop's debit and releases the tips.
- [x] Paid tips marked in the iSolved export: a memo column (`M_Tips Paid Out_Dollars`), part of `E_Cash Tips Recd`, checked by the reconciliation, required while Stripe payouts are on.
- [x] Test mode only: live keys are refused for employee accounts, onboarding, transfers and payouts until `MONEY_MOVEMENT_LIVE=true`.
- [x] One money-movement module (`src/server/payments/money-movement.ts`) for debits, transfers, payouts and unwinding, offered to the mobile agent's Connect work through NOTES-SYNC.
- [x] Never stored or returned: card, bank or routing numbers, SSNs or IDs. Migration `core_0100_staff_tip_stripe`. Tests: `tests/db/tip-stripe.test.ts`, `tests/db/staff-api.test.ts`, `tests/db/tips.test.ts`, `tests/payroll-engine.test.ts`.

**Still open:**
- [ ] Charles to confirm the iSolved code for the paid-out memo column, and that the platform keeping the instant fee when the shop pays it is right.
- [ ] The mobile agent's answer on sharing (or taking over) the money-movement module.
- [ ] A real run against a Stripe test account with Connect turned on (the tests use a stand-in for Stripe).

## 36. Staff payout onboarding (everyone re-registers)

Charles decided that all staff re-register: no Squire staff Stripe account is migrated, and every employee does fresh Stripe onboarding under Ray'z. README "Tip payouts" and "Cutover plan", and NOTES-SYNC "Tip payouts", have the details.

- [x] Onboarding tracker in the brand and shop admin (**Payroll → Payout onboarding**, `tips.approve`, one shop or every shop they can see): not invited, invited, started, blocked on Stripe's requirements (with what Stripe needs), verifying, or done, plus invites and reminders sent and tips waiting. Only whether there's an email or mobile number is shown, not the details.
- [x] Bulk invites by text, email or both (falling back to whichever they have), up to 500 at once, each audited. Someone already done, verifying, invited in the last 10 minutes or with no contact details is skipped with the reason.
- [x] Reminders from the notifications cron, in shop hours (9 AM to 7 PM), every 3 days and up to 4 times by default (brand settings). They stop when the person finishes, leaves or a manager stops them.
- [x] Tip payouts stay pending, never lost: a Stripe payout for someone who can't be paid yet is held for their setup instead of being paid in cash or failing. Its tips stay with it, and it goes back to pending (or is sent, once the batch is approved) as soon as Stripe can pay them. Managers can't release it by hand. The employee sees what's waiting on My tips, My banking and in the staff app.
- [x] Cutover checklist item: the last day Squire pays each shop's tips, who isn't onboarded yet, and a sign-off that waits until everyone is done unless an owner gives a reason (audited with who wasn't). The cutover list shows how many are onboarded at each shop.
- [x] Migration `core_0101_staff_onboarding`. Tests: `tests/staff-onboarding.test.ts`, `tests/db/staff-onboarding.test.ts`, `tests/db/cutover.test.ts`, `tests/tips.test.ts`.

**Still open:**
- [x] L34: someone who leaves before finishing Stripe setup. Offboarding or making them inactive lets go of their held payouts: open periods' tips go with their last paycheck (claimed by their final pay), locked periods' in cash from the next batch. Charles can still choose another rule.
- [ ] A real invite and onboarding run against a Stripe test account with Connect turned on.

## 37. Staff app API gaps from the Rayz App builder (ST-C1 to C10, ST-I1 to I8, ST-I10)

From the builder's `staff-api-gaps.md` and `staff-app-plan.md`. Every route goes through `staffRoute`: the version gate, the token, `X-Shop-Id` through `assertShopAccess`, then `authorize`. README "Staff app API", NOTES-SYNC "Staff app API" and [docs/staff-payout-cutover.md](docs/staff-payout-cutover.md) have the details.

- [x] ST-C1 sign-in by a texted or emailed code, and refresh tokens bound to the install.
- [x] ST-C2 permissions on every route, with `X-Shop-Id` checked against the caller's shops and path ids against the tenant guard.
- [x] ST-C3 the day calendar (their column or everyone's), booking, moving, status changes, running late, openings and blocks.
- [x] ST-C4 client search and the client card as Client data protection shows it, reveal with a reason, no contact details and no export.
- [x] ST-C5 their timecard and sign-off; managers' list, approval, punch fixes with reasons, and the iSolved CSV.
- [x] ST-C6 earnings by pay period from the payroll run (to the cent), and year to date with the Squire import.
- [x] ST-C7 a configurable payout model: **card tips straight to the employee's bank by Stripe** (Charles's decision), with **through payroll (iSolved)** as each shop's alternative setting. `FEATURE_STAFF_STRIPE_PAYOUTS=false` (`src/server/tips/payout-model.ts`) switches Stripe off for a deployment, hiding every employee bank onboarding screen.
- [x] ST-C8 push for confirm, reschedule, cancel, arrived, running late, waitlist, clock-out reminders and schedule changes.
- [x] ST-C9 the payout cutover report, each barber's confirmation or dispute, the manager's sign-off, the YTD import, and the runbook (SR1 to SR8).
- [x] ST-C10 app invites by text or email from **Users**, the invite page that opens the app, sessions, and signing someone out of every phone.
- [x] ST-I1 to I8 and I10: time off requests and decisions (I1), milestones (I2), walk-ins (I3), checkout with the shop's card fee (I4, Tap to Pay behind its flag), calls and texts through the shop line (I5), the front-desk kiosk (I6), the manager board (I7), `/config` with the version and switches (I8), and the staff privacy, terms and support pages (I10).
- [x] OpenAPI for every path, with its permission and the 426 response. Migrations `core_0102_staff_app_gaps`, `core_0103_staff_app_invite_jobs` and `core_0104_staff_payout_confirm_scrub`. Tests: `tests/db/staff-app-api.test.ts`, `tests/db/staff-api.test.ts`, and the staff app section of `tests/db/tenant.test.ts` (outsiders, Coralville ids and canaries).

- [x] ST-I9 per-employee Stripe accounts with onboarding from the staff app (Charles's decision, 2026-10-27; since section 49, recipient accounts with no dashboard and embedded onboarding), with the rest of sections 35 and 36: standard and instant payouts, payout webhooks, the onboarding tracker, bulk invites with reminders, and tips held until onboarding is done. On by default.

**Still open:**
- [x] L37: shop goals (ST-I2). The brand sets them under Setup → Staff milestones (counts only, week or month, every shop or some); `GET /me/milestones` returns `shopGoals` and the web Milestones page shows them. Shop totals only, never money.
- [ ] Tap to Pay (`FEATURE_STAFF_TAP_TO_PAY`) needs Apple's entitlement and a Terminal location per shop, when Charles says go.

## 38. W-2 safeguards for tips paid straight to employees

Charles's requirement with the Stripe decision: the tips stay W-2 wages, so payroll includes them and withholds on them from regular pay. README "Tip payouts" (W-2 safeguards) has the details.

- [x] Every direct tip payout goes to iSolved as tips already paid: `E_Cash Tips Recd_Dollars` with the paid-out memo, which can't be turned off while Stripe payouts are on.
- [x] Reconciled to the cent per employee, shop and pay period against the tip ledger and the payouts (`src/server/payroll/tip-reconcile.ts`); a difference blocks approve and lock while Stripe payouts are on.
- [x] Each payout records the employee, pay period, shop, gross tips, adjustments and card fee per period (`tip_payout_periods`, migration `core_0105_tip_payout_periods`, backfilled), next to its Stripe transfer and payout ids. An adjustment never lands in a locked period.
- [x] Payroll-period tip report (`/admin/payroll/tips`) by employee: tips earned, in payroll, paid direct, paid out, still owed and what the file carries, with every payout and its Stripe ids, and a CSV for payroll.
- [x] No 1099s from Stripe: accounts made with the platform paying Stripe's fees (no 1099-K) and tagged as W-2 employees'; an account Stripe reports as paying its own fees has its payouts held; the Dashboard import setting every employee account's 1099 to not required.
- [x] Pay through payroll stays as each shop's setting. Tests: `tests/db/tip-w2.test.ts`, `tests/db/tip-stripe.test.ts`, `tests/db/tips.test.ts`.

**Needs Stripe or the CPA to confirm:**
- [ ] Stripe: that W-2 employees' tip payouts to recipient accounts are an approved use, and that platform-paid fees mean no 1099-K for them.
- [ ] Stripe: the 1099 filing-requirement override (NOT_REQUIRED) for these accounts and turning off 1099 e-delivery to them.
- [ ] CPA: tips reported in the pay period they were earned, including ones still held for Stripe setup, which are taxed before they're received.
- [ ] CPA: card fee netting and the instant payout fee against gross tips as W-2 wages (the file reports gross).
- [ ] Charles and iSolved: the memo code (`M_Tips Paid Out_Dollars`) and using `E_Cash Tips Recd_Dollars` for tips paid by Stripe.
- [ ] Live money movement (`MONEY_MOVEMENT_LIVE`) only after all of the above.

## 39. Payroll reports (iSolved stays the system of record)

Confirmed with Charles: iSolved is the payroll company and keeps computing paychecks, taxes and blended overtime. Reports → Payroll shows what the platform sends it, from the same Payroll Report each period is approved and locked on. README "Payroll reports" has the details.

- [x] Brand-only by default: Brand Owner, Brand Admin and Bookkeeper hold view and export for all eight; no location role does, and a shop login never can (migrations `core_0106_payroll_export_sends`, `core_0107_payroll_export_sends_scrub`). Each is its own permission under **Reports: payroll (iSolved)**.
- [x] Every report filters by pay period (chips for each pay group's recent periods, from Payroll setup, bi-weekly by default), shop, employee and date range.
- [x] Payroll summary per employee: regular and OT hours from the time clock, hourly rate, gross hourly pay, service and product commission, card and cash tips, tips already paid via Stripe, and the total to iSolved (rates and totals need `payroll.rates`).
- [x] Timesheet detail: punches, breaks, every manager edit with its reason, and each timesheet's sign-offs, approvals and lock.
- [x] Tips: card vs cash, Stripe payouts made (Stripe ids only), sent and pending, waiting on Stripe setup, and family and shared ticket splits.
- [x] Commission by service and product, tying to the payroll commission to the cent (refunds and overrides on their own row).
- [x] Full-time status: averaging more than 32 hours a week over the Payroll setup window, week by week, with the line on the chart.
- [x] Labor cost vs sales per shop, as a percent of revenue, per pay period, with a trend.
- [x] Overtime watch: in overtime, projected over from this week's schedule, or within 4 hours, across every shop of the company.
- [x] iSolved export preview: the file row by row and each employee's tips against their Stripe payouts to the cent.
- [x] CSV and PDF export of every report; one-click iSolved export per pay period (one workbook, a tab per shop) with status draft, approved or sent. Marking sent needs `payroll.approve` with every shop, is refused until locked and reconciled, can be undone with a reason, and is audited.
- [x] Charts: stacked pay and tip bars, threshold lines for 32 and 40 hours, labor % trend. Tests: `tests/db/payroll-reports.test.ts`.

**Needs Charles to confirm:**
- [ ] Whether franchisee owners should get the payroll reports (they have the older tip reports today). Off until he says.
- [ ] That "sent" is marked by hand after the Timecard Import upload; there's no iSolved API to confirm it.

## 40. Staff payouts update (Rayz App builder, ST-I9 to ST-I15, ST-C12 to ST-C15)

Stripe can't transfer from a shop's connected account to a barber's, so the money flow is being redesigned as separate charges and transfers (ST-C11, pending Charles). This update leaves the transfer path out and keeps money movement abstract. README "Tip payouts → Staff payouts update" has the details. Migrations `core_0108_staff_payouts` and `core_0109_tip_employer_backfill`.

- [x] ST-I9: one recipient connected account per barber: no Stripe Dashboard, the transfers capability only, the recipient service agreement, Ray'z paying fees and losses. Embedded onboarding through an Account Session (`POST /api/staff/v1/banking/account-session`), with an Account Link as the fallback.
- [x] ST-C12: Connect webhooks drive a seven-state machine (not started, in progress, pending verification, requirements due, restricted, active, rejected), each move audited.
- [x] ST-C13: Reports → Payroll → Tips paid and its iSolved CSV per pay period, employer and employee, final only when earned = via Stripe + cash + through payroll + owed to the cent, the period is locked and the codes are set.
- [x] ST-C14: owed tips (no active account, or no transfer path) are paid through payroll at approve and lock, claimed once and never paid again.
- [x] ST-C15: a full refund within the window (7 days by default) reverses the tip; partial and later refunds and card disputes are absorbed by the shop; both are in the export.
- [x] ST-I11: the payout tracker with `payouts.view`, `payouts.manage` and `payouts.chain`.
- [x] ST-I12: Instant Payouts opt-in, off by default, on only after the barber accepts the fee as shown.
- [x] ST-I13: tax forms set to will not file, with a yearly check and a weekly reminder until it's recorded.
- [x] ST-I14: every tip and absorbed tip tagged with its shop and employer (the EIN's last 4 only).
- [x] ST-I15: HTTPS return and refresh pages, with the staff app's universal links and App Links in the `.well-known` files.
- [x] Tip date defaults to the sale date. Every rule is a brand setting (**Tip payout settings → Staff payouts**).
- [x] Tests: `tests/staff-payouts.test.ts`, `tests/db/staff-payouts.test.ts`, `tests/db/tip-stripe.test.ts`, and the updated tip, onboarding and staff API tests.

**Not done yet:**
- [x] ST-C11: the transfer path (`platformTipTransfers`): a platform-balance transfer to the employee's account, then their payout, with a reversal if the payout fails. Tested against a stand-in Stripe. It pays shops that settle to the brand's account; live money waits for `MONEY_MOVEMENT_LIVE` (the CPA).
- [ ] ST-C11, the charge side: shops on their own connected accounts need `chargeCard` to leave card tips on the platform (mobile, bc-645fbcc0; NOTES-SYNC Requests). Until then their payouts are held as owed and go through payroll.
- [ ] Embedded components on the web: My banking still uses the Account Link, since `@stripe/connect-js` isn't installed. The staff app uses the Account Session.
- [ ] A run against real Stripe test mode (recipient accounts, the Account Session, the webhooks); the tests use a stand-in client.

## 41. Payroll review (Claude bot: SB-C1, C2, C3, C6, C7, I2)

README "Payroll reports → Payroll review fixes" has the details. Migrations `core_0110_payroll_review` and `core_0111_tip_declarations_scrub`.

- [x] SB-C1: imported Squire tickets and `squire_import` payments are left out of payroll sales, payroll tips, the Payroll Report, the iSolved files and the tip ledger; they're shown only in a reference table on the Tips report.
- [x] SB-C1: a locked period stays as exported: the snapshot's input hash, drift and late-import flags, and no reassigning tickets or declaring tips in it.
- [x] SB-C2: a tip refunded after it was paid is a flagged adjustment, never takes the payable below zero, and is the shop's cost by default (a brand setting, with the IL WPCA and Iowa 91A warning on deducting).
- [x] SB-I2: the brand pay calendar anchor is a payroll setting; `PAYROLL_ANCHOR_END` is gone.
- [x] SB-C3: cash tip declarations in the staff app (`/api/staff/v1/tips/declarations`), at clock-out (staff app and web), on My tips, and by a manager on the timesheet with a reason. Append-only with corrections, a monthly reminder and close, refused in locked periods. They feed the payroll summary, the tips report and their own iSolved column.
- [x] SB-C7: Reports → Payroll → W-2 tip and overtime codes: qualified tips (TP) and the overtime premium (TT) per employer and employee, with each employee's tipped occupation code.
- [x] SB-C6: Reports → Payroll → FICA tip credit (45B): tips above the $5.15 an hour floor and the estimated credit, per pay period, employee and employer.
- [x] Tests: `tests/db/payroll-review.test.ts`, `tests/db/payroll-reports.test.ts`, `tests/db/staff-api.test.ts`, `tests/tip-declarations.test.ts`, `tests/payroll-engine.test.ts`, `tests/staff-payouts.test.ts`.

**Not done yet:**
- [ ] The CPA's and iSolved's confirmation of the declared tips earning, the electronic declaration, the TP and TT codes and premium method, and the 45B floor and start date (DEPLOY step 43).
- [ ] The staff app's own screens for declarations and the clock-out field, by the Rayz App builder: the API and its OpenAPI entries are ready.
- [ ] A filed W-2 or Form 8846: the reports are figures for the CPA and iSolved, not filings.

## 42. Staff delta for Squire (ST-C0a to C18, I10 to I20, N7, N8)

README "Staff app API → Staff delta for Squire" has the details. Migrations `core_0112` to `core_0125`.

- [x] ST-C0a and C0b: Squire-imported tips stay out of the time clock CSV and the payout batches, and payable tip outputs never go below zero.
- [x] ST-C0c: per-address and per-email limits and an escalating lock, two-step sign-in required for privileged roles, a 15-minute step-up for reveal, export and refund, a session per browser with revoke (**My sign-in security**), new-device emails, a 30-day idle end for app sessions, and front-desk clocks paired by a manager's QR code.
- [x] ST-C18: tips are never reduced by fees, with database checks and tests for checkout, the ledger and the batch payout.
- [x] Imported upcoming appointments queue reminders only when asked, and consent is rechecked at send. The pay-period start is the brand pay calendar setting.
- [x] ST-C16: cash tip declarations at clock-out with the attestation, a reminder on the 1st, a last call on the 9th, and a close on the 10th.
- [x] ST-C17: versioned, revocable deposit consent, recorded append-only, required before any Stripe payout. Tips on the paycheck is behind a brand flag, off.
- [x] ST-C13: W-2 box 12 TP and TT, the 14b occupation code, the tip-credit data (45B monthly, from 2025 at $7.25), and separate iSolved columns for owed tips in payroll and Stripe-paid tips.
- [x] ST-C15: no claw-back after transfer; the shop absorbs refunds, now the only option.
- [x] ST-C9: the per-shop tips cutover checklist with the three-way tie-out and the manager's and CPA's sign-offs.
- [x] ST-I14: a legal entity (FEIN last 4) per shop with state registrations, stamped on punches, time entries, tip payouts, declarations and locked periods.
- [x] ST-I16: Illinois and Iowa rule sets: minimum wage, Illinois meal periods and missed-meal flags, the Illinois paid leave report, and payroll split by entity and work state.
- [x] ST-I17: the no-biometrics CI check for the web and both apps.
- [x] ST-I18: the phone data policy (encrypted 24-hour cache, app lock, blur, no copy or share), `X-Staff-Cache`, wipe on refused sessions with `POST /auth/wiped`, and offline punches.
- [x] ST-I19: the Demo Shop and reviewer login for App Review, behind `FEATURE_STAFF_REVIEW_LOGIN`.
- [x] ST-I20: quiet hours: no non-urgent texts or pushes off the clock.
- [x] ST-I10: the employee privacy notice from a data map, pay questions with escalation to the owners, the promised deletions, and the release gate.
- [x] ST-N7 (tip pool rules, no pool) and ST-N8 (paystub names in earnings).

**Held or not done yet:**
- [ ] ST-C5's exact punches, cross-shop weekly overtime and buddy-punch rules: held until iSolved Time is decided.
- [x] ST-C11 / I10: the CPA's sign-off for tips to barbers' Stripe accounts (Charles, 2026-10-28). `FEATURE_TIP_TO_BARBER` is on by default, in the sandbox and at launch.
- [ ] Live money: `MONEY_MOVEMENT_LIVE=true` once live keys have been tested end to end, and Stripe's confirmation of no 1099-K for the barbers' accounts.
- [ ] Legal review of the privacy notice and the agency details. The release gate fails until it's done (DEPLOY step 44).
- [ ] The CPA's confirmation of the new iSolved columns, the 45B start and the state rates.
- [ ] The staff app's screens (two-step setup, step-up, pairing, deposit consent, data protection, Question my pay, paystub labels), by the Rayz App builder. The API is ready.
- [x] L38: Demo Shop clients stay out of brand-wide lists: the admin client list and its export, duplicates, the report builder and Campaign Center audiences, as well as search. The reviewer sees only them. Gift cards can't reach them (nothing is sold there). `tests/db/demo-shop.test.ts`.
- [ ] The audit log and sent messages aren't purged.

## 43. The basic time clock ships at launch (Charles)

Employees clock in and out at the shop, because the Payroll Report's hours come from the time clock. README "Payroll → Hours from the time clock" and DEPLOY step 45.

- [x] Hours per employee, per shop and per pay period come from punches, with breaks (unpaid at 30 minutes or more) and manager edits that need a reason and keep before and after.
- [x] ST-I6, kiosk mode with a manager's QR pairing: built (`/clock/pair`, `POST /clock/kiosk/pair`, PIN punches with breaks). **Critical for launch** in the staff app.
- [x] Approve and lock waits until every shop's timesheets are locked for the period (setting **Hours come from the time clock**, on by default); a timesheet locks only once it's manager-approved with no missed punches.
- [x] Payroll Report flags: missed punches, open shifts, timesheets not approved, service sales on a day with no hours, sales with no hours in the period, and hours typed in or imported.
- [x] The full Payroll Report spec from Charles's spreadsheet (section 6).
- [ ] The staff app's kiosk mode, by the Rayz App builder (NOTES-SYNC Requests). The API is ready.
- [ ] Still held: ST-C5's exact punches, cross-shop weekly overtime and buddy-punch rules, until iSolved Time is decided.

## 44. Times read 12-hour (Charles: no military time)

README "Times read 12-hour" and DEPLOY steps 46 and 47. Migrations `core_0126_brand_display` and `core_0127_time_format`.

- [x] Every time on screen reads 12-hour with AM and PM (`9:05 AM`): the time clock, timesheets and punch edits, the calendar, reports and on-screen previews, emails and the staff app's config. Time fields show AM and PM instead of the browser's 24-hour picker.
- [x] A brand setting, **Time format**, 12-hour by default; 24-hour only if the brand picks it. It's `brand_settings.time_format`, shared with the customer app, and core uses the customer app's formatter (`formatTime`/`formatDateTime`, `src/server/brand-time.ts`) rather than a second one.
- [x] Kiosk and QR punches go in at the server's UTC time, never the device's; the QR code is checked against server time.
- [x] Workweeks and overtime in America/Chicago, DST-safe by real elapsed time, with tests across both changes.
- [x] Sales keep service, product, tax and tip separate, never netted; each refund is its own dated record.
- [x] Times stay UTC instants in the database, shown in the shop's time zone.
- [x] **Payroll hours** read decimal (the workbook's style, the default) or as hours and minutes; the iSolved file stays decimal.
- [x] Charles's spreadsheet spec shows hours as decimals with 2 places, the default.
- [ ] The Ray'z Staff app formats times from `GET /config` `display.timeFormat` (NOTES-SYNC Requests).
- [ ] The customer app (PR #2) drops its own `time_format` column add and keeps core's `brand-time.ts` when it rebases (NOTES-SYNC Requests).

## 45. iSolved pay calendar (from iSolved, via the Isolved Bot, still being confirmed)

[docs/payroll-report-spec.md](docs/payroll-report-spec.md) §4 and DEPLOY step 49. Migration `core_0129_pay_calendar`.

- [x] Ray'z Inc. is one legal entity (one FEIN); every pay group defaults to it.
- [x] An iSolved pay group code per shop (`pay_groups.isolved_code`), one shop per code: B is Rock Island, C is Moline. It's shown on the Payroll Report and in Payroll → Setup, and file names can use `{code}`.
- [x] The default pay calendar is iSolved's: bi-weekly Sun–Sat from 10/4/2026 as period 22 (period 21 = 9/20–10/3, check 10/9; period 22 = 10/4–10/17, due 10/21, check 10/23). It's configurable in Payroll → Setup.
- [x] Each period's check date and submit-by date are stored (`pay_period_dates`), and can be moved with a reason for every shop with that period, but not once it's locked. The Payroll Report says when hours are due in iSolved and warns once that date has passed.
- [x] The OT workweek starts Sunday (it already did).
- [ ] The other shops' iSolved pay group codes, entered on Payroll → Setup once iSolved confirms them.
- [ ] Dubuque's numbering: the seed has 10/4–10/17 as Dubuque's period 01, and iSolved gives it as period 22. Unchanged until confirmed.

## 46. Payroll spec review (Claude bot: 6 Critical, 13 Important, 10 Nit)

The iSolved file's columns, headers, order and codes stay exactly as in Charles's workbook. Anything that would change them is a switch, off, and listed under "Needs Charles" on PR #1.

- [x] C4: overtime adds hours at every shop of one legal entity per Sun–Sat workweek (Ray'z Inc. is one entity, a field per pay group).
- [x] C5: Squire-era sales (`is_imported`, `squire_import`) stay out of sales, refunds and tips.
- [x] C6: overtime comes from punches. Adjustments can't go below the punches, are brand-only (`payroll.run`) and audited.
- [x] C2: training on top of clocked hours counts toward OT (a setting, on), never counted twice.
- [x] I2: pay periods start on Sunday. Late commission for a locked period is paid in the next one, with retro OT (`core_0130`).
- [x] I4: refunds lower commission before the greater-of; the rest is written off and flagged.
- [x] I10: card surcharge and loyalty in the commission base are settings, defaulting to today's behavior.
- [x] I12: the golden check flags circular, out-of-block and row-skipping totals.
- [x] N7: a tip paid on a locked period's ticket after the lock is paid in the next open period, on the day it came in (payroll and the tip ledger), and flagged there; the locked period doesn't drift.
- [x] I8: whoever changes a period's figures by hand (an adjustment, late commission, or hours entered, imported or deleted) can't approve them; someone else with Approve and lock does. The Brand Owner may approve their own changes, recorded as such on the trail. Locking what someone else approved stays open to the preparer.
- [x] N6: ACA hours (Reports → Payroll → ACA hours): hours of service per calendar month (worked, training and PTO at every shop) over a 3, 6 or 12-month measurement period, full time at an average of 130 a month (130 included), hires measured from their hire month, and full-time equivalents by month. Separate from the brand's 32-hour line.
- [x] N9: final pay for someone who leaves before the period ends: preview through the last day, approve, and a one-row iSolved file per shop for an off-cycle upload. The regular run leaves them out and flags them (and any change afterward), and their rows count in the W-2 tip check.
- [x] Hand-worked tests: OT from punches, effective-dated rates, cross-shop totals, DST and refund order.
- [x] Privacy: the docs and tests carry only made-up figures, and a test guards it.
- [ ] C1 (Needs Charles): regular-rate OT on commission is computed and flagged; the file column is a switch, off.
- [ ] C3 (Needs Charles and his CPA): card tips off Cash Tips Recd; the column setting is unchanged.
- [x] Q11: training on top of clocked hours (§56).
- [ ] Q15 (loyalty in the commission base).

## 47. Launch day: every surface at the same time (Charles, Oct 28)

The web platform, the iOS and Android customer apps and the Ray'z Staff app go live on the same day at the same time, each complete and tested in the sandbox first. PR #1's launch list has the gate (L67 to L71), and DEPLOY.md has the runbook ("Launch day").

- [x] The runbook: store submission lead times, holding approved builds for release, the launch-time switches and the cutover order.
- [x] Server-side levers that need no app release: the booking switch (Setup → App switches, app and website), each shop's Online booking switch, minimum versions and the maintenance message in both apps' `/config`.
- [ ] Charles: the launch date and time, which shop is the pilot (section 48), and whether the Play Console account is a personal or an organization account (a personal account adds a 14-day closed test).
- [ ] Mobile: the customer apps submitted to App Review and Google Play at least 3 weeks ahead (5 for a new personal Play account), held for release.
- [ ] Staff app builder: the same for the Ray'z Staff app, with kiosk mode (ST-I6).
- [ ] Each app tested in the sandbox against the real API (PR #7's apps run on a mock today), its status posted in NOTES-SYNC.
- [ ] Mobile: PR #3's `LAUNCH_AT` rebased and landed first, so one instant opens every surface.
- [x] Charles: PR #4's option B stands. Every surface goes live at once, and the shops follow the rollout in section 48.
- [ ] All four surfaces tested together in the sandbox on the builds being released.

## 48. The rollout: one pilot shop, then the rest (Charles, Oct 28)

Charles approved the plan: (1) all scope, the apps included, complete and tested in the sandbox; (2) one pilot shop goes live while Squire stays as its backup; (3) the other shops switch after one clean pay period. The runbook is `docs/rollout-runbook.md`; DEPLOY.md step 51 and "Launch day" follow it.

- [x] Per-shop go-live flags on **Setup → Rollout** (`core_0134_rollout`): wave (one pilot), planned go-live, the first pay period whose payroll comes from here, and Squire backup until. Nothing changes until a shop has a row.
- [x] The wave gate: a second-wave shop can't **Sign off and switch**, or be set to book here in Shop settings, until an owner signs off the pilot's clean pay period and the pilot still books here. A hand back clears the sign-off.
- [x] The clean pay period: payroll from here, booked here the whole period, over, approved and locked, nothing changed since, tips tie out to the cent, no late commission; plus the owner's note on what can't be checked (paychecks right, iSolved took the file, no complaints).
- [x] Squire's Commissions report imported per shop and pay period (service and product blocks, names matched to the Staff page's Squire name, nothing saved on any problem, replaced until the lock).
- [x] Payroll for a period mixing shops on the platform and shops on Squire data: one run, approval refused until each Squire shop's report is in, punches and tickets at a Squire shop left out, Squire-paid tips all in `E_Cash Tips Recd`, OT, PTO and training typed, overtime across both flagged (`cross_source_ot`), mismatched booking and source flagged (`rollout_source`), and each locked period keeps its source.
- [x] The staff app's earnings say which shops' figures come from Squire data (`source`, `squireImported`).
- [x] Tests: `tests/squire-commissions.test.ts` and `tests/db/rollout.test.ts` (a mixed period approved, locked and exported; the wave gate before and after the sign-off and after a hand back).
- [x] The per-shop migration and cutover runbook, with rollback and the mid-period hand back.
- [ ] Charles: which shop is the pilot, and its go-live day (the first day of a pay period).
- [ ] In the sandbox: whether Squire's Commissions report can be filtered to one shop (if not, export it with a Shop or Location column).
- [ ] The whole runbook rehearsed for the pilot on a staging copy, including one mixed pay period imported, approved and locked (C14).
- [ ] The pilot's first clean pay period signed off; then the second wave.

## 49. Tip payout details (Charles and the Claude bot's review, Oct 28)

These supersede any earlier wording that conflicts.

- [x] **A. Barber accounts:** Connect recipient accounts with `controller.stripe_dashboard.type = "none"` (ST-I9) and embedded onboarding (Account Sessions), not Express. Barbers get no Stripe dashboard login (the dashboard link answers `409 no_stripe_dashboard`), and 1099 tax reporting stays off. The tip payout settings can't pick Express, a full dashboard or hosted onboarding; an old stored value is read as the fixed one. Shops' accounts are unchanged. Recorded in NOTES-SYNC.md.
- [x] **B1. No tip clawbacks:** a refund or a lost dispute after a tip transfer books a `platform_losses` row (`core_0137_platform_losses`) for what the shop's transfer can't cover. The shop's reversal covers only the shop portion (the sale amount); a tip transfer is never reversed (a database trigger refuses a tip transfer as a recovery).
- [x] **B2. `source_transaction`:** every sale transfer (shop and tip) is created with the charge as its `source_transaction`, so it waits for the funds; one without it is refused. No negative platform balances. (The money returned after a won dispute is the one shop-only exception, since its charge was already paid out.)
- [x] **B3. Refund order:** a refund comes out of the sale portion first. Past the sale portion the platform absorbs the tip portion and logs it. This is the brand setting **A refund bigger than the sale's portion** (`tip_refund_overflow`, per shop since section 50): the platform absorbs it (default), or it's recovered from the shop's next transfers.
- [x] **B4. Keys:** one `transfer_group` per ticket; idempotency keys `{saleId}:shop` and `{saleId}:tip`, stored per transfer (a split ticket or several barbers add the payment or barber to the key). Older transfers keep their old keys.
- [x] **B5. Payroll:** tips export to iSolved as `E_Cash Tips Recd_Dollars`. A tip refunded after its period was exported or approved is flagged on the Payroll Report (`tip_refunded_after_export`) and never netted negative.
- [x] **B6. The flag:** `FEATURE_TIP_TO_BARBER` is on in the sandbox and by default (CPA approved), and it's turned off per shop with the brand setting `tip_to_barber` (section 50). Barber payout onboarding (setup, invites, reminders, the staff app's banking) is available wherever the flag is on and hidden where it's off; a barber who already finished setup can still update it.
- [x] Tests: `tests/staff-payouts.test.ts`, `tests/charge-split.test.ts`, `tests/money-movement.test.ts`, `tests/db/separate-charges.test.ts`, `tests/db/tip-stripe.test.ts`, `tests/db/staff-onboarding.test.ts`, `tests/db/staff-api.test.ts`, `tests/db/payroll-review.test.ts`.
- [ ] **Confirm with Charles:** `tip_refund_overflow`. When a refund is bigger than the sale amount, does the platform absorb the tip portion (the default), or is it recovered from the shop's next transfers?

## 50. Tips to barbers controls in the brand login (Charles, Oct 28)

- [x] **Tips to barbers on or off** is the brand setting **Tips to barbers' Stripe accounts** (`shop_setting:tip_to_barber`, into `shops.tip_to_barber`) in the brand login, under **Tip payout settings → Tips to barbers**. It's sent with the standard brand picker: all shops or the shops chosen, keep or replace a shop's own value, now or later. The per-shop switch on each shop's row is gone; each shop's current value is listed below the setting.
- [x] **A refund bigger than the sale's portion** is placed the same way (`shop_setting:tip_refund_overflow`, into the new `shops.tip_refund_overflow`, `core_0138_tip_payout_controls`). It's no longer part of `staff_payouts`; a brand that had chosen the shop moves onto every shop. Still marked **Confirm with Charles** (section 49).
- [x] **Permission** `tips.barber_payouts` (brand-only, privileged): Brand Owner and Brand Admin to start, and it can be granted to another brand-wide role. It's checked on preview, send, scheduled runs, bulk push or reset, and undo; `tips.settings` or `settings.brand` alone can't change either setting.
- [x] **Audit:** every change is logged per shop (`tips.tip_to_barber`, `tips.tip_refund_overflow`, with who, before and after) and for the brand, plus the sync itself (`brand_sync.apply`, `brand_sync.rollback`).
- [x] Tests: `tests/db/tip-payout-controls.test.ts`, `tests/db/separate-charges.test.ts`, `tests/permissions.test.ts`, `tests/staff-payouts.test.ts`.

## 51. Shop login: the front desk's POS (Charles, Oct 28)

As in Squire, a shop login is a POS and front-desk tool, not an admin console (launch checklist L79).

- [x] **What a shop login does:** its shop's calendar and booking; check-in; checkout and the POS (services, products, tips, card, cash or split tender, the card fee as the brand set it); client lookup; the time clock and kiosk; We have openings per barber; and its shop's own reports, as its role allows. That's the Shop Login role, as before.
- [x] **What stays the brand's:** settings, prices and the menu, staff setup and commission rates, roles and permissions, payroll, the Stripe and tip payout switches, the Campaign Center and integrations. The brand sends them to shops through brand sync.
- [x] **No role makes a shop login an admin console:** owner-only and brand-only permissions never reach a shop login, whatever its role. The brand-controlled shop permissions (`SHOP_LOGIN_BRAND_GRANTED`: shop settings part by part, taxes, booking timing, block reasons, notifications, shop prices, promos, inventory, schedules, the payout tracker, the Campaign Center and client campaigns) are off for a shop login even on the Shop Manager role. Refunds, voids, exports, staff contact, pay and roles were already never allowed (`SHOP_LOGIN_NEVER`).
- [x] **Unless the brand grants it:** someone with access to all shops can allow one of those for one shop login, as a per-login override under Roles and permissions. A shop manager who can manage permissions can't add or take back one of those on a shop login. Brand sync's **Shop edits** (Sync status) still decides which synced settings any shop may change; by default it can't.
- [x] **Touch-first for front-desk tablets:** a shop login gets big tabs (Front desk, Calendar, Checkout, Clients, Walk-ins, Time clock, Openings, Reports, only those it can open), with everything else under More, instead of the sidebar. Buttons, fields and links are at least 48 pixels tall, with 16-pixel text in fields so tablets don't zoom.
- [x] **Fast checkout:** the shop login's home is today's clients with one big Check in, then Check out, button each; the checkout queue (ready tickets first); and New sale. After payment the receipt offers **Next client**, back to the home. The home refreshes every 30 seconds.
- [x] The permissions screen says why a shop login doesn't have a brand-controlled permission ("set by the brand").
- [x] Tests: `tests/shop-login.test.ts`, `tests/db/front-desk.test.ts`, `tests/db/tenant.test.ts`.
- [ ] **Ask Charles:** a person on the Shop Manager role (not a shop login) still changes the shop settings their role gives them, as brand sync's Shop edits allow. Should managers follow the same brand-only rule? (Answered for pay data on Oct 28: managers get no payroll or tips unless granted, section 52.)

## 52. Testing Bot's launch test plan and the §6 resolutions (Charles, Oct 28)

The plan's P0 cases must all pass in the sandbox before the pilot. Status by case ID: [docs/test-plan-status.md](docs/test-plan-status.md).

- [x] **Shop login vs Squire:** compared screen by screen (NOTES-SYNC "Shop login vs Squire"); closed the "Shared shop login" label (FD-01), a read-only Service menu for the desk, and high-intent calls on the phone agent.
- [x] **Roles (G-1, G-10, `core_0139`):** Apprentice and Bookkeeper templates, editable; Shop and Regional Managers have no payroll or tips by default, only by a grant. The test plan's four extra sandbox accounts exist.
- [x] **Rollback (G-3, `core_0140`):** catalog bulk uploads get a one-step undo, like brand sync's other pushes.
- [x] **Names (G-4):** marketing messages use the barber's display label, as the booking pages do.
- [x] **TCPA (G-6, G-8):** boxes unchecked; a client's own opt-out never overwritten; automated client texts only 9 AM to 8 PM in the recipient's local time.
- [x] **Payroll (G-12 to G-17, G-25):** hours from the built-in time clock; exactly 8 columns; per-tab workbook formats with Roboto; OT pay in labor cost and the golden files; training pay out until Q11; OT per Sun–Sat workweek, attributed to the period with the hours past 40; a flagged Sunday punch in the workweek that starts that Sunday (G-11); FT on a rolling 4 weeks of worked hours; explicit Nov 1 and Mar 14 DST tests; the repeated hour shown with its zone (G-23).
- [ ] **Ask Charles:** tips owed through payroll now sit in `E_Cash Tips Recd_Dollars`, a memo earning iSolved doesn't pay in the check. They're flagged, and approve-and-lock still marks them paid. Pay that fallback in cash at the desk, or allow one paid earning code?
- [ ] **Ask Charles:** the export's 2-decimal rounding (Q4) is still off by default; the plan's PY-RD-01 assumes it's on.

## 53. My Earnings on the staff app (Charles, Oct 28)

- [x] The Rayz App builder's contract (it replaces the first sketch): `/me/pay-periods`, `/me/earnings?period=current|<id>`, `/me/earnings/days`, `/me/earnings/tickets?date=` and `/me/payouts`, in integer cents.
- [x] Tips per ticket and per day, card and cash on tickets against cash declared, a split ticket's share (`/me/earnings/days` and `/me/earnings/tickets`).
- [x] Hours, hourly pay, commission and the greater-of (which rule applied and why), worked out on the server from their Payroll Report line (`employeePay`), so the app does no pay math.
- [x] Pay-period totals equal to their Payroll Report row and their row in the iSolved file, to the cent (tested).
- [x] Each card tip's Stripe transfer and the Stripe payout to their bank: Stripe's status (pending, in transit, paid, failed, canceled) and arrival date (`/me/payouts`). "Reversed" appears only when Stripe itself reversed a transfer; a bank return fails the payout.
- [x] Their own only, on the server: no staff id taken, extra parameters refused, no shop login. Negative tests: `tests/db/my-earnings.test.ts`.
- [x] claude bot's corrections:
  - [x] **One engine:** earnings come from the payroll engine's `periodPay`. Locked and exported periods serve the lock's snapshot and are never recomputed. `periodStatus` and `isEstimate` are on every endpoint. A contract test checks earnings equal the report and the export to the cent for every golden row.
  - [x] **OT:** `workweeks[]` per Chicago workweek, with hours counted across shops. OT dollars are labelled an estimate; the brand Payroll Report still counts OT pay in labor cost.
  - [x] **Late changes:** a cash tip declared, or a card tip refunded, after export becomes a flagged adjustment in the next open period. A locked period is never reopened, pay is never negative, and no tip is clawed back.
  - [x] **Privacy:**
    - The employee comes from the token only: a staff id is 400 and other employees' ids are 404.
    - `Cache-Control: private, no-store` on every answer.
    - Staff MFA on the session, set up in the app if needed (`core_0142`).
    - Every view audit-logged.
    - Client first names only.
    - Tenant and IDOR tests, including a barber at two shops and shops gated by the rollout pilot (`tests/db/my-earnings-privacy.test.ts`).
  - [x] **Contract:** tickets take `periodId` plus a Chicago date. Transfer status and payout status are separate fields, and a payout is never "reversed". Tips follow each shop's tip switch.
- [ ] The My Earnings screen in the staff app (the Rayz App builder; request in NOTES-SYNC), now with the MFA screens.
- [ ] **Ask Charles:** My Earnings MFA is on in production and off in the sandbox demo. Turn it on in the sandbox once the app has the screens, and ask for it on the web's own tips page too?
- [ ] **Ask Charles:** should Barber and Apprentice have **See their own pay** (`compensation.own`) by default? Without it, every pay field is null.
- [ ] **Ask Charles:** paid time off shows at their wage (iSolved pays it at its own rate), and a sale's card tip Stripe itself reverses isn't paid to them again on its own. Both OK?

## 54. Training pay (Charles, Oct 28)

- [x] Training pay = training hours × the training rate, its own line outside the greater-of: never commission, Total Wages or NetComm (engine tests, and the golden rows' greater-of columns unchanged).
- [x] The training rate is per employee and effective-dated, on their Staff page (`core_0143`): each day's training at the rate in effect that day, a change mid-period flagged as mixed. A rate starts after the last locked period and only one that hasn't started, and no locked period used, can be deleted (`core_0144`). Brand-wide payroll admins set it, never their own.
- [x] Fallbacks: Payroll setup's training rate, then the hourly rate, flagged `no_training_rate`.
- [x] In Labor Cost and the totals on the Payroll Report (the old "Training pay is labor cost" setting is gone), and in the approve-and-lock gate: Training Pay against `E_Training_Hours` at each rate, and each line's Labor Cost.
- [x] Exported in `E_Training_Hours`, the format unchanged (golden export test, cell for cell).
- [x] Its own line in `/me/earnings`, top level and per shop, to the cent with the report (`tests/db/training-pay.test.ts`, `tests/my-earnings-contract.test.ts`).
- [x] C2 stays a setting, on by default. Overtime past the hours clocked at a shop comes off that shop's training, never negative regular hours (`training_overtime`).
- [x] Locked periods keep their figures.
- [x] **Answered (Charles, Q11, section 56): training is on top of clocked hours and counts.** Asked: does training count toward the weekly 40, and are training hours on top of clocked hours? Until then, training counts (FLSA: training is generally hours worked).
- [x] **Answered (section 56): OT comes out of regular hours and every training hour is paid at the training rate.** Asked: when training on top of clocked hours takes a week past 40, the overtime comes out of regular hours as any overtime does, so the hourly side of the greater-of drops by those hours. Keep that, or take the overtime from training first?
- [ ] **Ask Charles:** My Earnings shows only the shops someone works at. Should it also show another shop where they have hours in the period, such as a day of training there? It's on the Payroll Report and in the iSolved file either way.

## 55. PPH, Productivity Per Hour (Charles, Oct 28)

- [x] Named "Productivity Per Hour (PPH)" everywhere it shows. Service PPH, the default = service sales before tax and tips, net of discounts and refunds ÷ clocked worked hours (regular plus overtime, not training or PTO). Product PPH and total PPH over the same hours. Totals are sales over hours, never an average (`tests/pph.test.ts`).
- [x] Clients per hour alongside it: completed service tickets ÷ the same hours, to the hundredth. Paid or partly refunded tickets with a service on them that wasn't refunded, credited to the ticket's barber; $0 comp services count, fully refunded, voided and product-only tickets don't. It's a column, a rank, a stat and a trend chart on the report, a review column on the Payroll Report (kept in the lock's snapshot), a Morning Dashboard row and column, and `clients` and `clientsPerHour` on `/me/earnings`.
- [x] Zero hours is N/A everywhere: not ranked, listed last.
- [x] The PPH report: per barber, per location and for the brand, over any range or pay period, ranked by any of the four (ties share a rank), highest or lowest first, sortable from the PPH headings, with a daily, weekly, monthly or pay-period trend. Barbers see only their own (`core_0145`, `tests/db/pph.test.ts`).
- [x] Payroll Report: four review columns on the blocks, the Locations view and the drill-down. They're never in the iSolved file or the workbook download, and they match the report over the pay period.
- [x] Morning Dashboard email: day and week to date, per location, against the brand and per barber.
- [x] Staff app My Earnings: `pph`, own only, top level and per shop.
- [x] Dashboard headline card on the brand dashboard and a shop's: today (shifts still on the clock counted to now), yesterday and the pay period to date (each shop's own period), barber and location leaderboards with the brand total, and a 14-day sparkline. A shop's dashboard shows only that shop; a barber without every barber's numbers sees only their own (`tests/db/pph-dashboard.test.ts`).
- [x] Product sales per client beside PPH: product sales before tax ÷ unique clients served on completed tickets, a client once however often they came, a walk-in once per ticket, N/A with no clients. A location's and the brand's clients are distinct across their barbers. A dashboard card (today, yesterday, period to date, barber and location leaderboards with the total, a 14-day sparkline), a rank, columns, stat and trend chart on the PPH report, a Morning Dashboard row and columns, and `productPerClient` on `/me/earnings`, own only (`tests/db/product-per-client.test.ts`).
- [ ] **Ask Charles:** product sales per client counts every completed ticket's client, product-only purchases included (a client who only bought product was still served). Should it count only clients who had a service? A family ticket counts its payer once: should each family member count? It's not a Payroll Report column; does he want one?
- [ ] **Ask Charles:** on the dashboard, today counts open shifts up to now. Is that how he wants a live PPH read, or only clocked-out hours? And should a shop's dashboard show the brand figure beside the shop's (it doesn't now; he said a shop's shows only that shop)?
- [ ] **Ask Charles:** Squire-era tickets count toward PPH on the days they were sold, though payroll leaves them out. Keep that? And should a commission base with the card fee or loyalty added (I10) also count in PPH, as the Payroll Report's Service$ does? For clients per hour: is a ticket the right unit (a family ticket counts once), and should a $0 comp service count as a client (it does now)?

## 56. Training toward overtime (Charles, Q11, Oct 28)

- [x] Training hours are on top of clocked production hours: production + training over 40 per Chicago Sun–Sat workweek is overtime, summed across every shop (C2 on; migration `core_0146` turns it on where it was saved off).
- [x] OT shared out to the shops in proportion to their hours, each shop's training counted. Training at a second shop gets its share there, taken from the training hours when nothing was clocked there (`training_overtime`).
- [x] Training pay = training hours × the flat training rate, outside the greater-of; OT comes out of regular hours.
- [x] OT hours in the existing `E_Overtime 1.5_Hours` column, the format unchanged; iSolved applies the rate.
- [x] Training cost and its share of OT cost in labor cost on the Payroll Report (Training Cost, inside Labor Cost) and in the reconciliation gate. Commission's regular-rate half-time is spread over production plus training hours.
- [x] Golden tests: 38 production + 4 training = 2 OT hours, and training at a second shop (`tests/payroll-training-ot.test.ts`, `tests/db/training-overtime.test.ts`); the golden fixtures' labor cost includes training.
- [x] The discrepancy doc records that the workbook missed this: claude's estimate, about 12.9 OT hours short for 4 barbers this period, roughly $101, from an even weekly split, labelled an estimate (section 16). **Resolved by Charles outside the platform** (Oct 28): kept for the record, not owed, no open adjustment.
- [x] `/me/earnings` counts training hours in weekly OT, with training's share on its `training` line.
- [ ] **Ask the CPA:** is training hours worked under the FLSA? Everything above rests on it.
- [x] Past periods: Charles settled the shortfall with the affected barbers himself (Oct 28). No retroactive correction on the platform; the go-forward rule is unchanged.

## 57. A date range on every report, especially payroll (Charles, Oct 28)

- [x] Every report has the same ranges, in this order: today, yesterday, this week, last week, this pay period, last pay period, month to date, last month, quarter to date, year to date. A report's own ranges come after them (`tests/report-range.test.ts`).
- [x] A specific pay period picked by number, one list per pay calendar the shops picked are on (Dubuque's is its own), newest first, this year and last.
- [x] Custom start and end dates, whole days in America/Chicago (swapped when entered backwards), on every report, labelled "Custom range".
- [x] Combined with the shop picker: one shop, several, a saved group or all shops. "This pay period" and "Last pay period" follow the calendar of the shops picked, the brand's when they differ (`tests/db/report-ranges.test.ts`).
- [x] Payroll Report: approve and lock, adjustments and the iSolved and tips-paid downloads only on a full pay period of a pay group (approval covers every shop on it, shown or not). Any other dates are review only, labelled "Not an official pay period", with no approve, lock or files; the downloads answer 409.
- [x] OT on any dates is still worked out per full Sun–Sat workweek. A week only partly in the dates is flagged with the week's OT and the part inside the dates.
- [x] Dashboard: the stats, PPH and product sales per client follow the range and shops picked, with a tile for the range, the leaderboards ranking it and its days on the sparkline (up to 62). "Up next" and who's in stay on today.
- [x] Each person's last range is remembered per report and on the dashboard (`core_0147`). Exports and the assistant don't change it.
- [x] Exports and emails carry the range: CSVs open with the report, dates, shops and time zone; PDFs and scheduled report emails show the range and time zone. Import files (QuickBooks, card payments, iSolved, the Locations workbook) keep their exact layout.
- [ ] **Ask Charles:** a review of the Payroll Report on dates that aren't a pay period leaves out shops whose payroll came from Squire then (Squire's report is per pay period). Is that right, or should those shops show their Squire totals for any period the dates touch?
- [ ] **Ask Charles:** should the dashboard keep his last range the next day (it does now, per the request), or go back to today each morning?

## 58. The Payroll Report on start and end dates (Charles, Oct 28; supersedes 57 where they differ)

Tests: `tests/db/payroll-ranges.test.ts`, one block per rule.

- [x] Rule 1: built on start and end dates (America/Chicago days, 12-hour times). Presets: current pay period, last pay period, this week, last week, month to date, custom. Each pay group has its own presets; Dubuque's run on its own calendar.
- [x] Rule 2: any range can be viewed and drilled into. OT per full Chicago workweek; a workweek the range cuts is flagged, and its OT shown as an estimate.
- [x] Rule 3: approve, lock and the per-shop iSolved downloads on whole workweeks that don't overlap a locked range (in code and by a database trigger); blocked otherwise, with a message. The pay period is the default.
- [x] Rule 4: sales, refunds, tips, commission (at the rate in effect on each sale date), training and hours on the same range, so two workweeks add up to their pay period.
- [x] Rule 5: `/me/earnings` and `/me/earnings/tickets` take from/to as well as periodId.
- [ ] **Ask Charles:** a workweeks run is locked with period number 0 and no check date of its own. Should iSolved get it as an off-cycle run, or is it only for closing weeks before a pay period is split?

## 59. Charles's payroll clarification (Oct 22): manual iSolved upload, detail CSV, lock on export, gross only

Tests: `tests/db/payroll-detail-send.test.ts`; gross only in `tests/db/my-earnings-privacy.test.ts`.

- [x] 1. No iSolved integration: no API, SFTP or scheduled push exists, and none was added. The per-shop iSolved timecard file is unchanged (Key = Employee Number, Training column, OT hours with no OT dollars, Cash Tips Recd) and is downloaded for upload by hand.
- [x] 2. A payroll detail and reconciliation CSV per period, for all shops and per shop, separate from the iSolved file. Per employee: regular, OT (cross-shop allocated) and training hours; training pay; commission; the greater-of top-up; card tips paid via Stripe; declared cash tips; and totals. It ties to the Payroll Report, the iSolved file and the Stripe payouts to the cent, and is refused until the $0.00 reconciliation passes.
- [x] 3. Lock on export: marking an approved period "Sent to payroll" locks it, and it's audited (`lockedOnSend`). Later changes become flagged adjustments in the next open period.
- [x] 4. My Earnings is gross only: there are no withholding or net pay fields, and `taxNote` says taxes are withheld through payroll.
- [x] 5. Card tips go to barbers through Stripe, and card sales to the shop's connected account, both unchanged. Tip totals stay in the iSolved file's `E_Cash Tips Recd_Dollars` column.
- [x] **Launch checklist:** CPA to confirm manual tip-reporting process (Stripe-paid card tips reported via the iSolved upload). Done: the CPA approved it and suggested it (Charles, Oct 22, 11:09 PM CT, relayed by the Rayz App builder).

## 60. iSolved's Payroll Run Schedule as the official pay periods (Charles, Oct 28)

Tests: `tests/isolved-pay-calendar.test.ts` (the file's validation) and `tests/db/pay-schedule.test.ts`.

- [x] The 243 periods of `drizzle/seed/isolved-pay-calendar.csv` are seed data (migration `core_0149_pay_schedule`, `pay_schedule_periods`), loaded as each pay group's official pay periods: iSolved's number, run (due) date and check date, written to its pay period dates.
- [x] B Rock Island, C Moline, D Utica, E Kimberly, F Silvis, G Coralville and LeClaire share one calendar, from 2026 period 23 (10/18–10/31, check 11/6) through 2027 period 26. Dubuque has the same dates numbered its own way, through the period ending 10/2/2027. Codes D–G are taken from the file.
- [x] The holiday shift: 2026 period 27 runs Tue 12/29 and pays Thu 12/31, and it stays 2026's period 27.
- [x] The payroll date-range presets and defaults (this and last pay period, the picker by number) are these periods.
- [x] Validation: every period is 14 days, Sun–Sat, with no gaps or overlaps per group. This is checked in a test, by a check constraint and by an overlap trigger.
- [x] Periods past the end of the file: flagged on the Payroll Report, and extended by an admin on Payroll setup (at most 27 at a time, audited).
- [ ] **Ask Charles:** LeClaire's and Dubuque's iSolved pay group codes (the file shows none).

## Deferred by decision

- I10 is decided: separate charges and transfers (section 5), with tips to barbers' recipient accounts on (`FEATURE_TIP_TO_BARBER`, the CPA approved it on 2026-10-28), turned off per shop with the brand setting `tip_to_barber` (section 50). Live tip transfers also need `MONEY_MOVEMENT_LIVE`.
- The C2 training setting stays a setting, on: Charles answered Q11 (section 56), and the CPA is to confirm training is hours worked under the FLSA.
- PR #8 isn't merged.
- `DEMO_MODE` isn't turned on in production, because it would break the Vercel demo.
