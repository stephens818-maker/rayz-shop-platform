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
- [x] Shops that aren't onboarded can't take cards.
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
