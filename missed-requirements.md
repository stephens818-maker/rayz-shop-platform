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

- [ ] Real Twilio API calls through a Messaging Service SID, with a per-shop or brand sender number.
- [ ] Status-callback webhook with signature verification.
- [ ] STOP, START, and HELP replies update the client's opt-in.
- [ ] Configured by `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID`; off until they're set. The outbox simulator stays for development.
- [ ] A2P 10DLC registration notes in the README.

**Email (Resend, or Postmark behind the same interface)**

- [ ] Real API integration with branded HTML templates and an unsubscribe link.
- [ ] Bounce and complaint webhooks that update opt-in.

**Push**

- [ ] Web Push (VAPID) for the booking site and the installable PWA.
- [ ] FCM and APNs-ready through the mobile API, with a device token registration endpoint.
- [ ] Customers opt in from the browser or the app.

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

**Consent**

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
- [ ] Quiet hours.
- [ ] Dedupe on reschedule.
- [ ] The STOP webhook and opt-out persistence.
- [ ] .ics content and updates.
- [ ] Webhook signature checks.
