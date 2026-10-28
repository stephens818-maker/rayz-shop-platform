import { z, ZodType } from "zod";
import * as S from "./schemas";

const schema = (s: ZodType) => {
  const js = z.toJSONSchema(s, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
};
const queryParams = (s: z.ZodObject) =>
  Object.entries(s.shape).map(([name, f]) => {
    const field = f as ZodType;
    const js = schema(field);
    return { name, in: "query", required: !field.safeParse(undefined).success, description: (js.description as string) ?? undefined, schema: js };
  });
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const shopHeader = { name: "X-Shop-Id", in: "header", required: false, description: 'A shop id to work in, or "all" for all their shops (where their role allows it). Their first shop when left out.', schema: { type: "string" } };
const deviceHeader = { name: "X-Clock-Device", in: "header", required: true, description: "This install's front-desk clock token, from POST /clock/kiosk/pair (or the older /clock/kiosk/register)", schema: { type: "string" } };
const installHeader = {
  name: "X-Device-Id",
  in: "header",
  required: false,
  description: "A paired clock's install id, the deviceId it sent to POST /clock/kiosk/pair. With it a paired clock needs no Bearer token; its token works from no other install.",
  schema: { type: "string" },
};

interface Op {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  /** Who may call it, as the brand's Roles and permissions say. */
  permission: string;
  tag: string;
  body?: ZodType;
  query?: z.ZodObject;
  params?: boolean;
  kiosk?: boolean;
  public?: boolean;
  /** 204 with no body. */
  empty?: boolean;
}

const ME = "Their own (not a shop login)";
const MORE: Op[] = [
  // ST-C1, ST-C10, ST-I8
  { method: "post", path: "/auth/code/start", tag: "Sign-in", summary: "Text (Twilio Verify where set up) or email a 6-digit sign-in code to the email or mobile number on file. The same answer whether or not it matches anyone. Rate-limited.", permission: "Anyone", body: S.CodeStartBody, public: true },
  { method: "post", path: "/auth/code/verify", tag: "Sign-in", summary: "The code: { tokens } or, with two-step sign-in, { twoFactor } for /auth/login/code. Five wrong codes and it's used up.", permission: "Any active staff login", body: S.CodeVerifyBody, public: true },
  { method: "get", path: "/auth/invite", tag: "Sign-in", summary: "The staff app invite screen: their first name, whether they set a password, and when it expires. 404 for a used, replaced or expired link.", permission: "The invite link", query: S.InviteQuery, public: true },
  { method: "post", path: "/auth/invite/accept", tag: "Sign-in", summary: "Use the invite (once): sets their password when they haven't one, then { tokens } or { twoFactor }.", permission: "The invite link", body: S.InviteAcceptBody, public: true },
  {
    method: "get",
    path: "/config",
    tag: "App",
    summary:
      "Read at launch, before sign-in, and never version-gated: minimum and latest versions per platform (send X-Client: ios|android and X-App-Version; older than the minimum is 426 upgrade_required on every other route), the maintenance message, switches (clock, stripePayouts, tapToPay), the payout default (stripe; payroll where FEATURE_STAFF_STRIPE_PAYOUTS=false), links to the staff privacy policy, terms and support, and legal versions. display says how times and hours read on every screen: timeFormat 12h (the default: 9:05 AM, 5:30 PM, never 24-hour) or 24h, its timePattern, the shop timeZone (times in responses are UTC ISO), and payrollHours (decimal or hm).",
    permission: "Anyone",
    public: true,
  },
  { method: "get", path: "/me/sessions", tag: "Me", summary: "Every phone signed in as them: the name it gave, when it signed in and was last used, and which is this one. Never an IP or token.", permission: "Signed in" },
  { method: "delete", path: "/me/sessions/{id}", tag: "Me", summary: "Sign one of their phones out (a lost phone); its tokens and pushes stop at once.", permission: "Their own", params: true },
  {
    method: "post",
    path: "/me/step-up",
    tag: "Me",
    summary:
      "Confirm it's them before a sensitive action (ST-C0c): their authenticator code once set up, else their password. Revealing a client detail answers 403 with error.details.stepUpRequired (\"reveal\") when this session hasn't signed in or stepped up in the last 15 minutes; call this, then retry. Wrong passwords count toward the account lock.",
    permission: "Signed in",
    body: S.StepUpBody,
  },
  { method: "post", path: "/me/sessions/sign-out-others", tag: "Me", summary: "Sign out every phone but this one. { ended }.", permission: "Their own" },
  // ST-C3
  { method: "get", path: "/me/calendar", tag: "Calendar", summary: "One day at one shop: their own column, or every barber's with calendar.view_all or calendar.manage (all=0 for just theirs). Blocks, clock state, appointments with names as Client data shows them. Never a client phone.", permission: "Signed in", query: S.CalendarQuery },
  { method: "get", path: "/me/schedule", tag: "Schedule", summary: "Same as GET /schedule.", permission: ME, query: S.ScheduleQuery },
  { method: "post", path: "/appointments", tag: "Calendar", summary: "Book from the phone: their own column unless they have calendar.manage; on the grid unless squeezeIn with calendar.squeeze_in. A new client's details each need Client data's add permission. Audited as staff_app.", permission: "Signed in; calendar.manage for others' columns", body: S.BookBody },
  { method: "post", path: "/appointments/{id}/status", tag: "Calendar", summary: "confirm, check_in, start, finish (to checkout), complete, no_show, cancel or undo: their own, or anyone's with calendar.manage. Audited.", permission: "Their own; calendar.manage for others'", body: S.StatusBody, params: true },
  { method: "post", path: "/appointments/{id}/move", tag: "Calendar", summary: "Move to another time or barber, with the web calendar's rules.", permission: "Their own; calendar.manage for others'", body: S.MoveBody, params: true },
  { method: "post", path: "/appointments/{id}/late", tag: "Calendar", summary: "The client told the desk they're running late: the barber gets an app alert (first name only). Nothing goes to the client.", permission: "Their own; calendar.manage for others'", body: S.LateBody, params: true },
  { method: "get", path: "/openings", tag: "Calendar", summary: "Open starts on a barber's grid for a service and add-ons on a day.", permission: "Their own; calendar.manage for others'", query: S.OpeningsQuery },
  { method: "post", path: "/blocks", tag: "Calendar", summary: "Block time (a reason from the shop's list). With clients booked in it, { saved: false, conflicts } (first names only) until confirm; they stay booked.", permission: "blocks.own; blocks.others for anyone's", body: S.BlockBody },
  { method: "delete", path: "/blocks/{id}", tag: "Calendar", summary: "Remove a block.", permission: "blocks.own; blocks.others for anyone's", params: true },
  // ST-C4, ST-I5
  { method: "get", path: "/clients", tag: "Clients", summary: "Search by name, client number or a phone's last 4. Only clients they've served, without clients.view_all. Up to 20; the search is logged, never the term. No export.", permission: "Signed in", query: S.ClientSearchQuery },
  { method: "get", path: "/clients/{id}", tag: "Clients", summary: "The client card as Client data protection shows it to them: hidden fields left out, masked ones masked, contact details never (use /contact). Notes, preferences, visits; ratings only with permission. Logged and counted toward lookup limits. 404 for a client they can't open.", permission: "Signed in", params: true },
  { method: "post", path: "/clients/{id}/reveal", tag: "Clients", summary: "One masked detail in full, with a reason; logged. Phone, email and address are never revealed in the app.", permission: "clients.reveal", body: S.RevealBody, params: true },
  { method: "post", path: "/clients/{id}/contact", tag: "Clients", summary: "A call bridged through the shop line, or a text from the shop's number (consent and STOP checked). The number never comes back.", permission: "clients.message", body: S.ContactBody, params: true },
  // ST-C5
  { method: "post", path: "/clock/in", tag: "Time clock", summary: "POST /clock/punch with type in. 409 with details.feature = clock while the app clock is switched off (STAFF_APP_CLOCK_OFF).", permission: "timeclock.punch", body: S.ClockInOutBody },
  {
    method: "post",
    path: "/clock/out",
    tag: "Time clock",
    summary: "POST /clock/punch with type out. With cashTips (where GET /clock has cashTips), declares today's cash tips too; the reply's cashTips has the declaration or why it couldn't be taken, and the punch stands either way.",
    permission: "timeclock.punch",
    body: S.ClockInOutBody,
  },
  { method: "get", path: "/me/timecard", tag: "Timecards", summary: "Their timesheet for a pay period at every shop: days, hours, overtime, breaks, problems, approvals, edits (who, when, why) and whether they can sign off. No punch photos.", permission: "timesheet.own", query: S.PeriodQuery },
  { method: "post", path: "/me/timecard/sign-off", tag: "Timecards", summary: "Sign off their own timecard for a shop and period.", permission: "timesheet.own", body: S.SignOffBody },
  { method: "get", path: "/timecards", tag: "Timecards", summary: "The team's timecards at the manager's shops for a period: hours, problems and approvals per person and shop.", permission: "timesheet.edit, timesheet.approve or payroll.export", query: S.TeamTimecardsQuery },
  { method: "get", path: "/timecards/export", tag: "Timecards", summary: "The iSolved import CSV (or every field) for a period, as text/csv. X-Payroll-Draft: true until the period is locked. Logged.", permission: "payroll.export", query: S.ExportQuery },
  { method: "get", path: "/timecards/{id}", tag: "Timecards", summary: "One person's timecard (id is the staff member) at the manager's shops, with the punches to fix. 404 outside their shops.", permission: "timesheet.edit, timesheet.approve or payroll.export", query: S.PeriodQuery, params: true },
  { method: "post", path: "/timecards/{id}/approve", tag: "Timecards", summary: "Approve after their sign-off, or with a note saying why not.", permission: "timesheet.approve", body: S.ApproveBody, params: true },
  { method: "post", path: "/timecards/{id}/punches", tag: "Timecards", summary: "Add a punch they missed, with a reason (edit log).", permission: "timesheet.edit", body: S.AddPunchBody, params: true },
  { method: "patch", path: "/punches/{id}", tag: "Timecards", summary: "Change a punch's time, type or shop, with a reason (edit log, before and after).", permission: "timesheet.edit", body: S.EditPunchBody, params: true },
  { method: "post", path: "/punches/{id}/void", tag: "Timecards", summary: "Void a punch with a reason; kept on record. 204.", permission: "timesheet.edit", body: S.VoidPunchBody, params: true, empty: true },
  // ST-C6, ST-C7, ST-C9
  {
    method: "get",
    path: "/me/earnings",
    tag: "Tips and pay",
    summary:
      "One pay period (any day in it), per shop and in total, from the same payroll run as the iSolved export, to the cent: hours (timesheet.own), card, cash and gift-card tips (tips.own), service and product sales with refunds netted (report.my_sales.view with reports.money), wages and commission (compensation.own). Parts they may not see are null. payout says how tips reach them. paystub (ST-N8): their lines in the shop's payroll file under the names the iSolved paystub prints (Regular, Overtime 1.5, Comm Sales, Cash Tips Recd…), with header, unit (hours or dollars), group (hours, tips or wages, filtered by what they may see) and memo for tips they already have; label the app's earnings with these. source (the rollout): platform, or squire for a shop still on Squire whose figures come from Squire's Commissions report (no tender split: its tips are all adjustmentsCents); squireImported is false until that report is imported for the period, so show it as not ready yet. tips.declaredCashCents is cash they declared and tips.cashTipsRecdCents their E_Cash Tips Recd (tips plus declared cash). pay (compensation.own): hourly pay on regular hours against service commission, greaterOf.result commission or hourly, greaterOf.paidCents plus productCommissionCents and lateCommissionCents adding up to totalWagesCents exactly, then OT, training, any guarantee top-up and the OT premium; commSalesCents is the E_Comm Sales column. reconciliation, checked on the server: isolved is every column of their row in the shop's iSolved file (amount) against their Payroll Report line (payrollReport), and tickets is GET /me/earnings/tips's totals against the report's TIPS and declared cash; matches is false when any shown check fails, and adjustedOnReport names report fields a manager typed over. Always their own: any query parameter but period is 400.",
    permission: "Any of those",
    query: S.PeriodEarningsQuery,
  },
  {
    method: "get",
    path: "/me/earnings/tips",
    tag: "Tips and pay",
    summary:
      "My Earnings, tips: the signed-in employee's own tips for the pay period holding `period`, at each shop. tickets: each ticket's card, cash and gift-card tip, refundedCents taken back, tipsCents net, shared (their share of a split ticket; nobody else's share is ever shown), and transfer (the card tip's transfer to their Stripe account at the sale, or null) and payout. days: the same by day, with declaredCashCents (cash they declared, SB-C3). adjustments: a manager's tip adjustments with the reason. totals.tipsCents is what the Payroll Report's TIPS adds up from and totals.cashTipsRecdCents adds declared cash, as E_Cash Tips Recd does; GET /me/earnings has the check. previous and next are a day in the periods either side (next is null for the current one). Always their own: any query parameter but period is 400.",
    permission: "tips.own",
    query: S.PeriodEarningsQuery,
  },
  {
    method: "get",
    path: "/me/earnings/transfers",
    tag: "Tips and pay",
    summary:
      "My Earnings, Stripe: for the pay period holding `period`, each of their card tips that went to their own Stripe account at the sale (I10): status (pending, sent, failed or cancelled) with statusLabel, stripeTransferId and sentAt, and payout, the tip payout that takes it on to their bank or debit card (status, statusLabel, stripePayoutId, paidAt; payoutStatusLabel says 'Not in a payout yet' while it waits in their Stripe balance). payouts: the period's tip payouts as GET /payouts shows them. totals by transfer status and paidOutCents. Always their own: any query parameter but period is 400.",
    permission: "tips.own",
    query: S.PeriodEarningsQuery,
  },
  { method: "get", path: "/me/earnings/ytd", tag: "Tips and pay", summary: "Year to date: Ray'z plus what was imported from Squire for the year (W-2 continuity), per shop.", permission: "Any of those", query: S.YtdQuery },
  {
    method: "get",
    path: "/me/payout-setup",
    tag: "Tips and pay",
    summary:
      "How each shop pays their tips: Stripe to their own bank or debit card (the default; set it up through /banking), payroll (iSolved) or cash. Every way, tips are W-2 wages withheld on through payroll. With payroll, bank details live in iSolved employee self-service: open payrollPortalUrl. stripePayouts.enabled is false where the deployment switched direct Stripe payouts off.",
    permission: "tips.own",
  },
  { method: "get", path: "/me/payout-cutover", tag: "Tips and pay", summary: "What Squire still owed them at the switch, Squire's last payout and Ray'z's first, and whether they've confirmed it.", permission: "tips.own" },
  { method: "post", path: "/me/payout-cutover/confirm", tag: "Tips and pay", summary: "Confirm the Squire amount, or dispute it with a note; the manager can't sign off the reconciliation while anything is disputed.", permission: "tips.own", body: S.CutoverAnswerBody },
  // ST-I10
  { method: "get", path: "/me/pay-questions", tag: "Tips and pay", summary: "Their pay questions, newest first, with the history (asked, answered, escalated, closed), who has it (manager or owner), when it's due and canEscalate.", permission: "timesheet.own" },
  {
    method: "post",
    path: "/me/pay-questions",
    tag: "Tips and pay",
    summary: "Question their pay for a shop (and pay period). The shop's timecard approvers and payroll people answer within 5 days, or it goes to the owners. Emails name the topic and period only. At most 10 open.",
    permission: "timesheet.own",
    body: S.PayQuestionBody,
  },
  { method: "post", path: "/me/pay-questions/{id}/escalate", tag: "Tips and pay", summary: "Send it to the owners (once), with a note; owners answer within 7 days.", permission: "timesheet.own", body: S.PayQuestionEscalateBody, params: true },
  { method: "post", path: "/me/pay-questions/{id}/resolve", tag: "Tips and pay", summary: "Close it: the answer settled it.", permission: "timesheet.own", params: true },
  { method: "get", path: "/pay-questions", tag: "Manager", summary: "Pay questions at their shops (never their own), open first, with canAnswer; escalated ones are answered by owners or payroll.approve only.", permission: "timesheet.approve, payroll.run, payroll.export or payroll.approve", query: S.TeamPayQuestionsQuery },
  { method: "post", path: "/pay-questions/{id}/answer", tag: "Manager", summary: "Answer it; the employee gets a push (held off the clock) and can close it or send it to the owners. 404 outside their shops or for their own.", permission: "timesheet.approve, payroll.run, payroll.export or payroll.approve", body: S.PayQuestionAnswerBody, params: true },
  // ST-I1, ST-I2
  { method: "get", path: "/me/milestones", tag: "Me", summary: "Trophies, personal bests, progress, congratulations; their rebook rate with the rebook report; teammates' only with reports.all_staff. shopGoals: the brand's goals at the X-Shop-Id shop (or all of theirs), each { shop, label, unit, periodLabel, from, to, current, target, pct, reached }: shop totals this week or month, never money.", permission: ME },
  { method: "get", path: "/me/time-off-requests", tag: "Time off", summary: "Their requests, newest first, and the reasons they can ask with (private reasons masked).", permission: ME },
  { method: "post", path: "/me/time-off-requests", tag: "Time off", summary: "Ask for time off at one shop or all of theirs, with the brand's notice rule. With clients booked, { saved: false, conflicts } (first names) until confirm. Approved requests become blocks.", permission: "timeoff.request", body: S.TimeOffBody },
  { method: "delete", path: "/me/time-off-requests/{id}", tag: "Time off", summary: "Withdraw their own request.", permission: ME, params: true },
  { method: "get", path: "/time-off-requests", tag: "Time off", summary: "Requests at the approver's shops (pending, or all from the last 14 days).", permission: "timeoff.approve", query: S.TeamTimeOffQuery },
  { method: "post", path: "/time-off-requests/{id}/decision", tag: "Time off", summary: "Approve (it becomes a block) or deny; they get a push either way. Returns the appointments in the way. 404 outside their shops.", permission: "timeoff.approve", body: S.DecisionBody, params: true },
  // ST-I3, ST-I4
  { method: "get", path: "/shops/{id}/waitlist", tag: "Walk-ins", summary: "Who's waiting (names as Client data shows them, never a phone; canText says a number is on file), the estimated wait, barbers and services.", permission: "walkins.manage", params: true },
  { method: "post", path: "/shops/{id}/waitlist", tag: "Walk-ins", summary: "A walk-in: seated now with a free barber, or added to the waitlist with a quoted wait.", permission: "walkins.manage", body: S.WalkInBody, params: true },
  { method: "post", path: "/waitlist/{id}/seat", tag: "Walk-ins", summary: "Seat with a barber at that shop; the barber gets \"you're up\".", permission: "walkins.manage", body: S.SeatBody, params: true },
  { method: "post", path: "/waitlist/{id}/status", tag: "Walk-ins", summary: "They left, or they're done. 204.", permission: "walkins.manage", body: S.EntryStatusBody, params: true, empty: true },
  { method: "post", path: "/waitlist/{id}/notify", tag: "Walk-ins", summary: "Text \"your chair is ready\" from the shop's number, unless they opted out of texts.", permission: "walkins.manage", params: true },
  { method: "post", path: "/sales", tag: "Checkout", summary: "The ticket for an appointment (theirs, or anyone's with checkout.any), priced by the server, with the credit card fee from the shop's policy (computeCardFee). Paying is at the front desk until Tap to Pay is switched on.", permission: "Their own; checkout.any for others'", body: S.SaleBody },
  { method: "post", path: "/terminal/connection-token", tag: "Checkout", summary: "A Stripe Terminal connection token for the shop's Terminal location (Tap to Pay). 403 with details.feature = tap_to_pay until FEATURE_STAFF_TAP_TO_PAY is on.", permission: "timeclock.punch, checkout.any or pos.custom_charge", body: S.TerminalTokenBody },
  // ST-I6, ST-I7
  { method: "get", path: "/clock/kiosk", tag: "Front-desk clock", summary: "The front-desk screen in one call: the rotating QR, the PIN pad's team and the walk-in queue (first names and waits; for a shop login or walkins.manage).", permission: "A paired clock (X-Device-Id), or timeclock.kiosk on a registered one", kiosk: true },
  { method: "get", path: "/clock/kiosk/queue", tag: "Front-desk clock", summary: "The walk-in queue alone: first names, positions and waits.", permission: "A paired clock; or timeclock.kiosk, and a shop login or walkins.manage", kiosk: true },
  { method: "get", path: "/manager/board", tag: "Manager", summary: "Today at one shop in the parts they may see (sees): each barber's clock and chair, the waitlist, time off to decide, timecards to approve, products running low.", permission: "Any manager permission", query: S.BoardQuery },
  { method: "post", path: "/staff/{id}/app-invite", tag: "Manager", summary: "Send someone the staff app's sign-in link by text or email; a new link cancels the last. link comes back only when it couldn't be sent.", permission: "permissions.manage", body: S.AppInviteBody, params: true },
  { method: "post", path: "/staff/{id}/sign-out", tag: "Manager", summary: "Sign someone out of the staff app on every phone (a lost or shared phone) without deactivating them. Deactivating does this too. 204.", permission: "permissions.manage", params: true, empty: true },
];

const RAIL_OFF = " 403 with details.feature = staff_stripe_payouts where FEATURE_STAFF_STRIPE_PAYOUTS=false switches direct Stripe payouts off; tips are paid through payroll (iSolved) there. See GET /me/payout-setup.";

const OPS: Op[] = [
  { method: "post", path: "/auth/login", tag: "Sign-in", summary: "Email and password. Returns { tokens } or, with two-step sign-in, { twoFactor: { ticket, enroll? } } for /auth/login/code.", permission: "Any active staff login", body: S.LoginBody, public: true },
  { method: "post", path: "/auth/login/code", tag: "Sign-in", summary: "The authenticator code for the ticket. A wrong code is 401 with details.twoFactor to try again.", permission: "Any active staff login", body: S.LoginCodeBody, public: true },
  { method: "post", path: "/auth/refresh", tag: "Sign-in", summary: "Rotates the refresh token. Reusing an old one ends every staff app session for that person. A token from a sign-in that sent deviceId works only with the same deviceId.", permission: "A live session", body: S.RefreshBody, public: true },
  { method: "post", path: "/auth/logout", tag: "Sign-in", summary: "Ends the session; its access token and its phone's pushes stop at once. 204.", permission: "A live session", body: S.LogoutBody, public: true, empty: true },
  { method: "post", path: "/auth/wiped", tag: "Sign-in", summary: "The app wiped its data after a 401 with details.wipe (ST-I18), sent with the session's last refresh token; recorded against that sign-in. 204, known token or not.", permission: "Any refresh token, live or ended", body: S.WipedBody, public: true, empty: true },
  { method: "post", path: "/auth/device/request", tag: "Sign-in", summary: "Approved-device sign-in: ask a manager to approve this install at a location whose sign-in rule takes approved devices, after a 403 with details.networkBlocked and details.deviceTicket (or while signed in, with Bearer, at a location blocked from here). Returns { shop, status: pending, deviceToken }. Keep deviceToken in secure storage and send it as X-Device-Token on sign-in and every request; it counts once approved. null when this install already has one (send it as X-Device-Token here too).", permission: "A blocked sign-in's ticket, or a live session", body: S.DeviceRequestBody, public: true },
  { method: "get", path: "/auth/device", tag: "Sign-in", summary: "What this install's X-Device-Token stands for: { devices: [{ shopId, shop, label, status }] }, status pending, approved, declined or revoked. Empty without a token.", permission: "X-Device-Token", public: true },
  { method: "get", path: "/me", tag: "Me", summary: "Who they are, their shops, the app features they may use and every permission they hold.", permission: "Signed in" },
  { method: "get", path: "/me/notifications", tag: "Me", summary: "How they hear about their own clients' bookings, changes, cancellations and arrivals, and their phones.", permission: "Their own (not a shop login)" },
  { method: "put", path: "/me/notifications", tag: "Me", summary: "Change it. push is the app.", permission: "Their own (not a shop login)", body: S.NotificationPrefsBody },
  { method: "get", path: "/schedule", tag: "Schedule", summary: "Their working days: hours, time off, lunch and other blocks (private reasons masked), and how many are booked.", permission: "Their own (not a shop login)", query: S.ScheduleQuery },
  { method: "get", path: "/appointments", tag: "Schedule", summary: "Their own appointments over the days asked, in start order. Last names follow Client data.", permission: "Their own (not a shop login)", query: S.AppointmentsQuery },
  { method: "get", path: "/appointments/{id}", tag: "Schedule", summary: "One appointment: theirs, or anyone's at their shops with calendar.view_all or calendar.manage. Otherwise 404.", permission: "Signed in; calendar.view_all for others'", params: true },
  { method: "get", path: "/appointments/{id}/notes", tag: "Client notes", summary: "The client's notes as Client notes' permissions show them (private manager notes need notes.private). Logged as a client view.", permission: "notes.view", params: true },
  { method: "post", path: "/appointments/{id}/notes", tag: "Client notes", summary: "Add a note for the appointment's client; a cut note (kind visit) is tied to this visit. Body as POST /staff/clients/{id}/notes.", permission: "notes.view, plus the note kind's write permission", params: true },
  { method: "get", path: "/clock", tag: "Time clock", summary: "Where they stand, what they can punch next, each shop's rule (QR, NFC, Wi-Fi, location), today's punches, break reasons and whether their PIN is set.", permission: "timeclock.punch" },
  { method: "post", path: "/clock/punch", tag: "Time clock", summary: "Clock in or out from their phone with the shop's proof. { kind: confirm } asks first during time off; clocking in returns welcome (milestones).", permission: "timeclock.punch", body: S.PunchBody },
  { method: "post", path: "/clock/breaks/start", tag: "Breaks", summary: "Start a break, with a reason and planned length; the calendar blocks it.", permission: "timeclock.punch", body: S.BreakStartBody },
  { method: "post", path: "/clock/breaks/end", tag: "Breaks", summary: "End the break.", permission: "timeclock.punch", body: S.BreakEndBody },
  { method: "put", path: "/clock/pin", tag: "Time clock", summary: "Set their own PIN for the front-desk clock.", permission: "timeclock.punch", body: S.PinBody },
  {
    method: "post",
    path: "/clock/kiosk/pair",
    tag: "Front-desk clock",
    summary:
      "Pair this install as a shop's front-desk clock with a manager's one-time code (ST-C0c), no staff sign-in: scan the manager's QR code (a link ending ?code=…) or type the code. 201 { token, device }; send the token as X-Clock-Device and the same deviceId as X-Device-Id on every kiosk call, with no Bearer token. Codes last 10 minutes and work once; 20 tries per address per 15 minutes.",
    permission: "A manager's pairing code (made in Time clock setup by someone with settings.shop)",
    body: S.KioskPairBody,
    public: true,
  },
  { method: "post", path: "/clock/kiosk/register", tag: "Front-desk clock", summary: "Make this install one of a shop's front-desk clocks. The token is returned once; send it as X-Clock-Device.", permission: "settings.shop", body: S.KioskRegisterBody },
  { method: "get", path: "/clock/kiosk/team", tag: "Front-desk clock", summary: "Who can punch here.", permission: "A paired clock (X-Device-Id), or timeclock.kiosk on a registered one", kiosk: true },
  { method: "get", path: "/clock/kiosk/qr", tag: "Front-desk clock", summary: "The link to draw as the QR code phones scan. It changes every 30 seconds.", permission: "A paired clock (X-Device-Id), or timeclock.kiosk on a registered one", kiosk: true },
  { method: "post", path: "/clock/kiosk/status", tag: "Front-desk clock", summary: "Their PIN, then what they can punch next. Five wrong PINs lock theirs for five minutes.", permission: "A paired clock (X-Device-Id), or timeclock.kiosk on a registered one", body: S.KioskStatusBody, kiosk: true },
  { method: "post", path: "/clock/kiosk/punch", tag: "Front-desk clock", summary: "Punch (in, out, break start or end) as the person whose PIN was typed.", permission: "A paired clock (X-Device-Id), or timeclock.kiosk on a registered one", body: S.KioskPunchBody, kiosk: true },
  { method: "get", path: "/tips", tag: "Tips and pay", summary: "Their tips (S3): today, settling, ready, in a payout, paid out; how each shop pays them; history by ticket.", permission: "tips.own", query: S.TipsQuery },
  {
    method: "get",
    path: "/tips/declarations",
    tag: "Tips and pay",
    summary:
      "Their cash tip declarations (SB-C3), newest first: current (not replaced by a correction) and closesOn (the day the month locks). rules: whether declaring is on, asked at clock-out, the attestation to show, the lock day. reminder: last month, when nothing's declared for it yet.",
    permission: "tips.own",
    query: S.DeclarationsQuery,
  },
  {
    method: "post",
    path: "/tips/declarations",
    tag: "Tips and pay",
    summary:
      "Declare cash tips they were handed for a day at a shop (0 counts), with the attestation checked; 201. A correction sends replacesId and a reason and keeps the shop and day. 409 once the pay period is locked or the month closed (a manager corrects it then).",
    permission: "tips.own",
    body: S.DeclareBody,
  },
  {
    method: "get",
    path: "/payouts",
    tag: "Tips and pay",
    summary: "Their tip payouts: method, status and what they got after fees. waitingForSetup marks a payout held until they finish Stripe payout setup; it goes out on its own then.",
    permission: "tips.own",
  },
  { method: "get", path: "/earnings", tag: "Tips and pay", summary: "Day by day: net sales (report.my_sales.view with reports.money), tips (tips.own) and commission (compensation.own, where the brand has compensation on). Parts they may not see are null.", permission: "Any of those", query: S.EarningsQuery },
  {
    method: "get",
    path: "/banking",
    tag: "Banking",
    summary:
      "Their Stripe Connect recipient account (no Stripe Dashboard login; set up with the embedded components): the account id, status, onboarding step (start, resume, update or done), Stripe's requirements (due, pending, deadline), the default card or bank's type, name and last 4, and instant payouts (allowed, the card they go to, the fee and who pays it). payoutOnboarding.available: false where tips to barbers are off at every shop they work at (FEATURE_TIP_TO_BARBER or each shop's switch); hide payout setup then (onboarding-link and account-session return 403 tip_to_barber_off until setup is done). waitingForSetup: tips approved for them and waiting until Stripe can pay them. Never a number.",
    permission: "tips.own",
    query: S.BankingQuery,
  },
  { method: "get", path: "/banking/external-accounts", tag: "Banking", summary: "Every bank account and debit card on their Stripe account: type, bank or brand name, last 4, which is the default and which takes instant payouts. Never a number. ?refresh=1 reads Stripe first.", permission: "tips.own", query: S.BankingQuery },
  {
    method: "post",
    path: "/banking/onboarding-link",
    tag: "Banking",
    summary:
      "The fallback to embedded onboarding: starts or resumes Stripe's hosted onboarding for their own Stripe account (identity, bank account, debit card for instant payouts), or opens it for what Stripe asks for later. step says which. Open url in the browser; Stripe returns to https://…/staff-app/stripe/return (or /refresh when the link ran out), which the app opens as a universal link or App Link. url is null in the simulator, where setup finishes at once. Stripe test mode only unless MONEY_MOVEMENT_LIVE is on.",
    permission: "tips.own",
  },
  {
    method: "post",
    path: "/banking/account-session",
    tag: "Banking",
    summary:
      "An Account Session for Stripe's embedded components (Connect.js): account_onboarding, account_management (change the card or bank: accounts have no Stripe Dashboard) and notification_banner. Returns clientSecret (short-lived; never store or log it), expiresAt, accountId and publishableKey. Call again when it expires. session is null in the simulator, where setup finishes at once. If embedded onboarding fails to load, fall back to /banking/onboarding-link.",
    permission: "tips.own",
  },
  { method: "post", path: "/banking/dashboard-link", tag: "Banking", summary: "Barbers' accounts have no Stripe Dashboard (recipient accounts, ST-I9), so this returns 409 outside the simulator: change the card or bank in the embedded account management (/banking/account-session). In the simulator it switches between a test card and a test bank.", permission: "tips.own" },
  {
    method: "put",
    path: "/banking/method",
    tag: "Banking",
    summary:
      "How they're paid, where the brand lets them choose. Instant payouts are off by default; turning them on shows Stripe's fee first and, where the brand asks, needs acceptInstantFee set to the fee text shown (400 with details.reason instant_fee_ack and details.terms otherwise). Sends a security notice.",
    permission: "tips.own",
    body: S.PayoutMethodBody,
  },
  {
    method: "put",
    path: "/banking/deposit-consent",
    tag: "Banking",
    summary:
      "Agree to, or withdraw from, being paid tips by Stripe deposit (ST-C17). Show depositConsent.text from GET /banking and send its version with agree true; a changed wording answers 400 with details.reason consent_version and details.version. Nothing is sent to Stripe for them without it: their Stripe payouts wait as owed. Withdrawing holds every Stripe payout not yet sent. Only the employee themselves; sends a security notice. Choosing tips on their paycheck (PUT /banking/method with payroll) is offered only where policy.tipsOnPaycheck is true.",
    permission: "tips.own",
    body: S.DepositConsentBody,
  },
  { method: "get", path: "/popups", tag: "Pop-ups", summary: "Milestones they haven't seen, a clock-in reminder when their first client or shift starts within 30 minutes, and an old open shift.", permission: "Signed in" },
  { method: "post", path: "/popups/seen", tag: "Pop-ups", summary: "Milestones shown: they won't pop up again here or on the web.", permission: "Their own", body: S.SeenBody },
  { method: "get", path: "/devices", tag: "Push", summary: "Their phones registered for push.", permission: "Their own" },
  { method: "post", path: "/devices", tag: "Push", summary: "Register this phone's push token for their own clients' new, changed and cancelled bookings. A first phone turns those on when they've never chosen.", permission: "Their own", body: S.DeviceBody },
  { method: "patch", path: "/devices/{id}", tag: "Push", summary: "A rotated token, notification permission or app version.", permission: "Their own", body: S.DevicePatch, params: true },
  { method: "delete", path: "/devices/{id}", tag: "Push", summary: "Stop pushes to the phone. 204.", permission: "Their own", params: true },
  ...MORE,
];

/** The staff app's API as OpenAPI 3.1, for the app builder. */
export function staffOpenApiDocument(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    const parameters = [...(op.params ? [idParam] : []), ...(op.query ? queryParams(op.query) : []), ...(op.public ? [] : [shopHeader]), ...(op.kiosk ? [deviceHeader, installHeader] : [])];
    (paths[op.path] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: `Permission: ${op.permission}.${op.tag === "Banking" ? RAIL_OFF : ""}`,
      ...(op.public ? { security: [] } : op.kiosk ? { security: [{}, { bearer: [] }] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(op.body) } } } } : {}),
      responses: {
        ...(op.method === "delete" || op.empty ? { "204": { description: "Done" } } : { "200": { description: "OK" } }),
        "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "401": { description: "Sign in required. details.reason and details.wipe (all, cache or none) say what the app deletes (see dataProtection in GET /config)" },
        "403": { description: "Their role or the location's sign-in rule doesn't allow it" },
        ...(op.path === "/config" ? {} : { "426": { description: "This app build is older than the platform's minimum (GET /config)" } }),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Ray'z Staff app API",
      version: "1",
      description:
        "For the Ray'z Staff app (replacing Squire Commander). Separate from the customer API at /api/v1. Sign in with email and password (and the authenticator code where set up), then send Authorization: Bearer <accessToken>. Access tokens last an hour; refresh with the rotating refresh token. Roles, permissions, Client data masking and each location's sign-in rule are enforced on the server on every request; where a location takes approved devices, send X-Device-Token (POST /auth/device/request) on sign-in and every request. Data on the phone (ST-I18): keep a response, encrypted for at most 24 hours, only when its X-Staff-Cache header is offline-24h; with no signal the app is read-only except clock punches, queued with queuedAt and clientPunchId. Kiosk and QR punches always go in at the server's UTC time, never the device's. GET /config dataProtection has the rest: app lock, snapshot blur, no copy or share, and wipes. Quiet hours (ST-I20): off the clock, non-urgent pushes are held until clock-in, the break's end or the next shift; GET /config quietHours lists which events always go at once.",
    },
    servers: [{ url: `${baseUrl}/api/staff/v1` }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] } },
          required: ["error"],
        },
      },
    },
    security: [{ bearer: [] }],
    paths,
  };
}

export const STAFF_API_PATHS = OPS.map((o) => `${o.method.toUpperCase()} ${o.path}`);
