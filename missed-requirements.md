# Outstanding requirements

Everything the owner asked for that isn't finished yet, in the order it's being worked on. Each item is ticked when it's merged into [PR #1](https://github.com/stephens818-maker/rayz-shop-platform/pull/1), and moves to the README's "What's done" at that point.

## 1. Private hosted preview

- [x] Vercel-ready config (`vercel.json`, the `vercel-build` script, Neon connection strings).
- [x] Demo data: 8 shops, barbers by first name, about 3,000 clients with families on a shared phone, appointments, sales, inventory, vendors, purchase orders.
- [x] Demo logins: brand owner, a shop login, a shop manager, a barber, with one-click sign-in.
- [x] Stripe, texts, and email in safe mock or test mode (`DEMO_MODE=true`).
- [x] `DEPLOY.md` with the exact steps, accounts, and environment variables.
- [ ] A permanent preview URL: needs the owner's Vercel project and Neon database (see `DEPLOY.md`). A temporary one is running from the agent's machine.

## 2. UX and design standard (applies to every screen)

- [ ] Design tokens for color, type, spacing, radius, and shadow, with light and dark mode; Inter.
- [ ] Consistent components, with shadcn/ui-style primitives on Tailwind.
- [ ] Micro-interactions and transitions; skeleton loaders instead of spinners; optimistic updates.
- [ ] Empty states with helpful calls to action; toast feedback.
- [ ] Cmd/Ctrl-K command palette and global search.
- [ ] Keyboard shortcuts on the calendar and checkout.
- [ ] Drag-and-drop on the calendar.
- [ ] Touch-friendly tablet layouts for the front desk, checkout, and the tip hand-off.
- [ ] Fully responsive mobile views for barbers.
- [ ] Fast page loads.
- [ ] WCAG AA accessibility.
- [ ] Polish pass on the calendar, checkout, client profile, reports, and brand portal, with before and after screenshots in the PR.

## 3. Customer notifications and calendar integrations

**SMS (Twilio)**

- [x] Real Twilio API calls: each shop's own Twilio number, else the Messaging Service SID, else `TWILIO_FROM`. Not yet tried against a real account (see section 10).
- [x] Status-callback webhook with signature verification (`/api/twilio/sms/status`; every `/api/twilio/**` route checks `X-Twilio-Signature`).
- [x] STOP and START replies update the client's opt-in (STOP turns off "OK to text" for every client on the number; START restores those same clients). HELP is answered by Twilio and only recorded.
- [x] Configured by `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM`); off until they're set. The outbox and a call and text simulator stay for development.
- [x] A2P 10DLC registration notes in the README and DEPLOY.md.

**Email (Resend, or Postmark behind the same interface)**

- [ ] Real API integration with branded HTML templates and an unsubscribe link.
- [ ] Bounce and complaint webhooks that update opt-in.

**Push** (owned by bc-645fbcc0, the mobile workstream: devices and push)

- [ ] Web Push (VAPID) for the booking site and the installable PWA.
- [ ] FCM and APNs-ready through the mobile API, with a device token registration endpoint. Owned by bc-645fbcc0.
- [ ] Customers opt in from the browser or the app. Owned by bc-645fbcc0.

**Reminder rules** (brand portal, with per-shop overrides)

- [ ] Booking confirmation.
- [ ] Reminders 24 hours and 2 hours before, with editable timings.
- [ ] Reschedule and cancel notices.
- [ ] A "running late" message sent by staff.
- [ ] A rebook nudge X weeks after the last visit.
- [ ] A no-show follow-up.
- [ ] An optional birthday message.
- [ ] Templates with merge fields: client first name, shop, barber first name or display label, date and time, manage-booking link.
- [ ] Quiet hours in America/Chicago.
- [ ] Sent through a background job queue with retries and dedupe.
- [ ] Sent even when staff can't see the client's contact details (masking applies only to staff views).

**Consent** (owned by bc-645fbcc0, the mobile workstream)

- [ ] Separate SMS, email, and push opt-ins, captured at booking with TCPA-compliant wording, a timestamp, and the source.
- [ ] Opt-outs stick: no re-import or booking can silently opt someone back in.
- [ ] Default to opted out.

**Add to calendar** (when the customer allows it)

- [ ] Google, Apple/iCal (.ics download), and Outlook, on the confirmation page, in the email, and through an SMS link.
- [ ] Includes the shop address, the barber's display name, and the manage link.
- [ ] Reschedules and cancels send an updated or cancelled event (same UID, higher SEQUENCE).
- [ ] An optional per-customer calendar feed URL of upcoming appointments, with a private token that can be revoked.

**Delivery tracking**

- [ ] Status per message: queued, sent, delivered, failed, opted out.
- [ ] Shown on the appointment and the client profile, subject to field permissions.
- [ ] A notifications report by shop, with an estimated SMS cost per channel.

**Tests**

- [ ] Scheduling and timing, including DST.
- [x] Quiet hours (call-in outreach: `tests/outreach.test.ts`, `tests/db/call-ins.test.ts`). Reminders don't have quiet hours yet.
- [ ] Dedupe on reschedule.
- [x] The STOP webhook and opt-out persistence (`tests/db/call-ins.test.ts`: STOP suppresses later texts, START restores, 9 stops automated calls).
- [ ] .ics content and updates.
- [x] Webhook signature checks (Twilio, `tests/outreach.test.ts`).

## 4. Booking time increments

- [x] Brand, shop, barber and barber-at-shop slot intervals, where the most specific wins.
- [x] Service duration steps, booking increments, and prep and cleanup buffers.
- [x] Per-barber durations.
- [x] The day calendar draws each barber's own grid, with drag-and-drop moves and a squeeze-in that needs a permission and is logged.
- [x] DB tests for mixed grids, multi-shop barbers, interval changes under existing bookings, buffers and DST days.

## 5. Stripe Connect, merchant of record (I10)

- [x] One platform account, and a connected (Express) account per shop.
- [x] Destination charges (`on_behalf_of` + `transfer_data`) to the shop where the service happened, with the processing fee as the application fee.
- [x] Refunds reverse the transfer.
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
- [x] Per-shop iSolved xlsx in the workbook's exact format, OT hours only, unrounded by default, formatting copied per tab and diffed in a test. Downloads only after approve-and-lock. No iSolved API.
- [x] FT/PT: averaging more than 32 h/week; basis and window are settings.
- [x] `docs/payroll-report-spec.md` and the anonymized `docs/payroll-workbook-discrepancies.md`.
- [ ] Charles: Q11 (training inside clocked hours; C2 flag off), Q17 (the owner row and the Coralville NetComm gap), the FT basis and window, and 2-decimal rounding (off).
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
- [x] Morning digest by email to the owner and managers, configurable at **Setup → Morning digest** (time, roles, people, sections), with a preview and a test send. It covers yesterday's sales by shop, today's team (working, off, blocked) and the alerts, each copy scoped to that person's shops and permissions. It's sent once per person per day.
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
  - [x] Stripe Connect Express accounts for staff, through Stripe-hosted onboarding (no bank details in the app; see My banking below). Transfers come from the shop's Stripe balance (or the brand's), with instant payout where eligible and its fee shown.
  - [x] Payroll export only.
  - [x] Each employee chooses, if the brand allows it.
- [x] Managers review and approve every batch, with each employee's breakdown by ticket. Hold, adjust, take out and cancel need a reason and go in the audit log; nobody adjusts their own.
- [x] The same tip can't be paid twice: claims under row locks, a database trigger, unique indexes and Stripe idempotency keys. History before tip payouts is recorded as already paid.
- [x] Reconciled against Stripe (`payout.paid`, `payout.failed`, `payout.canceled`, `transfer.reversed`, `account.updated`) and against the cash drawer. A failed payout reverses the money and puts its tips in the next batch.
- [x] Permissions: `tips.own`, `tips.approve` and `tips.settings`.
- [x] **My banking** (`/admin/my-banking`):
  - [x] Employees add or change their bank account or debit card on Stripe's hosted Express pages (onboarding through an Account Link, changes in their Express dashboard). Stripe collects identity, tax and bank details. The app keeps only the Stripe account id, its status, and the type, bank or card name and last 4 that Stripe returns.
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

- [x] Bank accounts, debit cards, SSNs and TINs, EINs, dates of birth for identity checks, ID documents and card numbers, for employees, shops and clients, are collected only on Stripe's surfaces: Connect onboarding and the Express dashboards, the Payment Element and Terminal. No page has a field for them, which a test checks.
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
- [x] Nav section **Campaign Center** (Campaigns, Blasts, My lapsed clients, Settings), pages under `/admin/campaign-center`, the report **Campaign Center** at `/admin/reports/campaign-center`, the cron at `/api/cron/campaign-center`.
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
  - a real email provider (Postmark broadcast stream or Resend; both are stubs) and real push (Expo stub).
- [ ] Message costs for ROI are estimates set under Campaign Center → Settings (1¢ a text, 0.1¢ an email by default); replace them with the real rates.
- [ ] "Nearby" for announcements uses the shops' coordinates (clients of locations within the radius), since client addresses aren't used. The seeded coordinates are approximate.
- [ ] "Finish your booking" only knows about the website's booking flow. App bookings would need to call `saveBookingDraft` (NOTES-SYNC).
- [ ] Which campaigns to switch on, their wording and coupons per location.
- [ ] Whether barbers should get **Campaign Center: own lapsed clients** by default, and the lapsed sequences' steps, coupons and "stop after" per location.

## Deferred by decision

- I10 stays on destination charges; separate charges and `payment_transfers` aren't built, and tips aren't transferred to shops separately. Tip payouts to employees (section 15) transfer from the shop's own Stripe account to the employee's.
- The Q11/C2 training flag stays off.
- PR #8 isn't merged.
- `DEMO_MODE` isn't turned on in production, because it would break the Vercel demo.
