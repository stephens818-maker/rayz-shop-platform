import { z } from "zod";
import { STAFF_CHANNELS, STAFF_EVENTS } from "@/domain/staff-notifications";
import { TIP_METHODS } from "@/domain/tips";
import { PAY_QUESTION_MAX_CHARS, PAY_QUESTION_TOPICS } from "@/domain/staff-privacy";

/** Request bodies and queries for /api/staff/v1, shared by the handlers and the OpenAPI document. */

const Device = z.string().max(80).nullish().describe("Shown on their sign-ins, e.g. Makenna's iPhone");
const DeviceId = z
  .string()
  .max(128)
  .nullish()
  .describe("A stable id for this install (e.g. identifierForVendor, or one the app stores in the keychain). The refresh token then works only with it, so a copied token is useless on another phone.");

export const LoginBody = z.object({ email: z.string().max(200), password: z.string().max(200), deviceName: Device, deviceId: DeviceId });
export const LoginCodeBody = z.object({ ticket: z.string().max(4000).describe("From the login response's twoFactor"), code: z.string().max(12), deviceName: Device, deviceId: DeviceId });
export const RefreshBody = z.object({ refreshToken: z.string().min(10).max(200), deviceId: DeviceId });
export const LogoutBody = z.object({ refreshToken: z.string().min(10).max(200) });
export const WipedBody = z.object({ refreshToken: z.string().min(10).max(200), wipe: z.enum(["all", "cache"]).describe("What it deleted: details.wipe from the 401") });
export const DeviceRequestBody = z.object({
  ticket: z.string().max(4000).nullish().describe("details.deviceTicket from the blocked sign-in (15 minutes). Leave it out while signed in (Bearer) at a location blocked from here"),
  shopId: z.uuid().describe("One of details.deviceShops"),
  label: z.string().max(40).nullish().describe("What the manager sees, like \u201cMakenna's iPhone\u201d. The app's name when left out"),
});

const Who = { email: z.string().max(200).nullish(), phone: z.string().max(40).nullish() };
export const CodeStartBody = z.object(Who).refine((v) => !!(v.email || v.phone), "Send email or phone").describe("Their email or mobile number on file. The answer is the same whether or not it matches anyone.");
export const CodeVerifyBody = z.object({ ...Who, code: z.string().max(12), deviceName: Device, deviceId: DeviceId });
export const InviteQuery = z.object({ token: z.string().min(10).max(200).describe("From the invite link /staff-app/invite/{token}") });
export const InviteAcceptBody = z.object({ token: z.string().min(10).max(200), password: z.string().max(200).nullish().describe("Required when the invite says setPassword"), deviceName: Device, deviceId: DeviceId });
export const AppInviteBody = z.object({ channel: z.enum(["sms", "email"]).nullish().describe("Text when they have a mobile number, else email, when left out") });

export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-10-27");

export const ScheduleQuery = z.object({
  from: DateStr.optional().describe("First day (shop time); today when left out"),
  days: z.coerce.number().int().min(1).max(62).optional().describe("How many days, 1 to 62; 7 when left out"),
  shopId: z.uuid().optional().describe("One of their shops; all they can reach when left out"),
});

export const AppointmentsQuery = ScheduleQuery.extend({
  status: z.enum(["all", "upcoming", "completed", "missed"]).optional().describe("upcoming, completed, missed (cancelled and no-shows) or all (the default)"),
});

export const IdParam = z.object({ id: z.uuid() });

const Gps = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable() })
  .nullish()
  .describe("Only where the shop's rule uses location");
const Proof = z
  .object({ qr: z.string().max(200).optional(), tag: z.string().max(64).optional() })
  .optional()
  .describe("The qr from the front-desk clock's QR code link (/admin/clock?shop=…&qr=…): signed, single-use, good for a minute. Without it (or a paired front-desk clock) a phone can't punch; an NFC sticker's tag no longer punches on its own");
const Photo = z.string().max(400_000).nullish().describe("A data: URL (jpeg, png or webp) where the shop asks for a punch photo; never face-matched");

const CashTips = z
  .object({
    cents: z.number().int().min(0).max(1_000_000).describe("Cash tips handed to them today that weren't rung up on a ticket; 0 is a declaration too"),
    attest: z.literal(true).describe("They checked GET /clock cashTips.attestation"),
  })
  .optional()
  .describe("Clocking out only, where GET /clock has cashTips: declares today's cash tips at the shop (SB-C3)");

/** ST-I18: a punch tapped with no signal, sent when the phone is back online. */
const Queued = {
  queuedAt: z.iso.datetime({ offset: true }).optional().describe("When it was tapped with no signal (at most 24 hours ago); the punch goes in at that time, flagged offline. Ignored with proof.qr (the front-desk QR code): a QR punch, like every kiosk punch, goes in at the server's time when it arrives, and the code has to be good then"),
  clientPunchId: z.uuid().optional().describe("The app's own random id for this punch: sending it again returns the first result instead of punching twice"),
};

export const PunchBody = z.object({
  shopId: z.uuid(),
  type: z.enum(["in", "out"]),
  proof: Proof,
  gps: Gps,
  photo: Photo,
  confirmTimeOff: z.boolean().optional().describe("Clock in anyway during time off, after the confirm reply"),
  cashTips: CashTips,
  ...Queued,
});

export const ClockInOutBody = PunchBody.omit({ type: true }).extend({
  shopId: z.uuid().optional().describe("Required unless token is sent"),
  token: z.string().max(600).optional().describe("The front-desk QR code (GET /kiosk/qr token) or the NFC sticker's link, as scanned: its shop and qr or tag stand in for shopId and proof"),
  cashTipCents: z.number().int().min(0).max(1_000_000).optional().describe("Clocking out: today's cash tips, the same as cashTips.cents; send attestation true with it"),
  attestation: z.boolean().optional().describe("With cashTipCents: they checked GET /clock cashTips.attestation"),
});

export const BreakStartBody = z.object({
  shopId: z.uuid().optional().describe("The shop they're clocked in at when left out"),
  breakReasonId: z.uuid().nullish().describe("From GET /clock breakReasons; none is Break"),
  plannedMin: z.number().int().min(5).max(240).nullish().describe("How long they plan to be; open when left out"),
  proof: Proof,
  gps: Gps,
  photo: Photo,
  ...Queued,
});

export const BreakEndBody = z.object({ shopId: z.uuid().optional(), proof: Proof, gps: Gps, photo: Photo, ...Queued });

export const PinBody = z.object({ pin: z.string().max(12).describe("4 to 6 digits, not one digit repeated or a run like 1234") });

export const KioskRegisterBody = z.object({ shopId: z.uuid(), label: z.string().max(60).describe("e.g. Front desk iPad") });
export const StepUpBody = z.object({
  password: z.string().max(200).optional().describe("Their password, when they have no authenticator set up"),
  code: z.string().max(12).optional().describe("The 6-digit code from their authenticator app, once set up"),
});
export const TwoFactorVerifyBody = z.object({
  ticket: z.string().max(4000).describe("The ticket from POST /me/two-factor/setup"),
  code: z.string().max(12).describe("The first 6-digit code the authenticator app shows for the new key"),
});
export const KioskPairBody = z.object({
  code: z.string().max(20).describe("The pairing code from the manager's QR code (its `code` query value), e.g. K7QD-M3XP"),
  deviceId: z.string().min(8).max(128).describe("This install's own random id; send it as X-Device-Id on every kiosk call"),
});
export const KioskStatusBody = z.object({ staffId: z.uuid(), pin: z.string().max(12) });
export const KioskPunchBody = KioskStatusBody.extend({
  type: z.enum(["in", "out", "break_start", "break_end"]),
  photo: Photo,
  confirmTimeOff: z.boolean().optional(),
  breakReasonId: z.uuid().nullish(),
  plannedMin: z.number().int().min(5).max(240).nullish(),
});

export const DeclarationsQuery = z.object({ from: DateStr.optional().describe("62 days ago when left out") });
export const DeclareBody = z.object({
  shopId: z.uuid(),
  businessDate: DateStr.describe("The day they got the tips; not in the future"),
  amountCents: z.number().int().min(0).max(1_000_000),
  attest: z.boolean().describe("They checked the attestation from GET /tips/declarations rules"),
  replacesId: z.uuid().nullish().describe("Correcting one of their declarations: same shop and day"),
  reason: z.string().trim().max(300).nullish().describe("Required with replacesId"),
});

export const TipsQuery = z.object({ days: z.coerce.number().int().min(1).max(60).optional().describe("History days, 1 to 60; 14 when left out") });
export const EarningsQuery = z.object({ from: DateStr.optional().describe("6 days before `to` when left out"), to: DateStr.optional().describe("Today when left out") });
export const BankingQuery = z.object({ refresh: z.enum(["1", "true"]).optional().describe("Ask Stripe for the latest first, e.g. after coming back from its page") });
export const PayoutMethodBody = z.object({
  method: z.enum(TIP_METHODS).nullable().describe("null follows the shop's default"),
  instant: z.boolean(),
  acceptInstantFee: z.string().max(200).nullish().describe("Turning instant payouts on: the fee text they were shown (GET /banking instant.fee.terms), exactly. Needed once per fee where the brand asks for it."),
});

export const DepositConsentBody = z.object({
  agree: z.boolean().describe("true agrees, false withdraws"),
  version: z.string().max(40).nullish().describe("Agreeing: the wording's version they were shown (GET /banking depositConsent.version), exactly"),
});

export const SeenBody = z.object({ ids: z.array(z.uuid()).max(50) });

export const DeviceBody = z.object({
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm", "expo"]),
  token: z.string().min(8).max(4096),
  appVersion: z.string().max(40).nullish(),
  osVersion: z.string().max(40).nullish(),
  pushEnabled: z.boolean().optional(),
});
export const DevicePatch = z.object({
  token: z.string().min(8).max(4096).optional(),
  pushEnabled: z.boolean().optional(),
  appVersion: z.string().max(40).nullish(),
  osVersion: z.string().max(40).nullish(),
});

export const NotificationPrefsBody = z.object({
  events: z.partialRecord(z.enum(STAFF_EVENTS), z.array(z.enum(STAFF_CHANNELS))).describe("confirm, reschedule, cancel, arrived: each to sms, email and/or push"),
  firstHours: z.number().int().optional(),
  secondHours: z.number().int().optional(),
});

// ───────────────────────────── Calendar (ST-C3) ─────────────────────────────

export const CalendarQuery = z.object({
  date: DateStr.optional().describe("Today when left out"),
  shopId: z.uuid().optional().describe("The X-Shop-Id shop when left out"),
  all: z.enum(["0", "1", "true", "false"]).optional().describe("0 for only their own column, where they may see everyone's"),
});
export const StatusBody = z.object({ action: z.enum(["confirm", "check_in", "start", "finish", "complete", "no_show", "cancel", "undo"]) });
export const BookBody = z.object({
  shopId: z.uuid().optional(),
  staffId: z.uuid().optional().describe("Their own column when left out; anyone's needs calendar.manage"),
  date: DateStr,
  startMin: z.number().int().min(0).max(24 * 60 - 1),
  serviceId: z.uuid(),
  addonIds: z.array(z.uuid()).max(10).optional(),
  customerId: z.uuid().nullish().describe("A client from GET /clients; or send customer for a new one"),
  customer: z.object({ firstName: z.string().max(60), lastName: z.string().max(60).optional(), phone: z.string().max(40).optional(), email: z.string().max(200).optional() }).nullish(),
  notes: z.string().max(500).nullish(),
  squeezeIn: z.boolean().optional().describe("Off the grid; needs calendar.squeeze_in"),
});
export const MoveBody = z.object({ staffId: z.uuid().nullish(), date: DateStr, startMin: z.number().int().min(0).max(24 * 60 - 1), squeezeIn: z.boolean().optional() });
export const LateBody = z.object({ minutes: z.number().int().min(1).max(120) });
export const OpeningsQuery = z.object({ shopId: z.uuid().optional(), staffId: z.uuid().optional(), date: DateStr, serviceId: z.uuid(), addonIds: z.string().max(400).optional().describe("Comma-separated add-on ids") });
export const BlockBody = z.object({
  shopId: z.uuid().nullish(),
  staffId: z.uuid().nullish().describe("Their own when left out; anyone's needs blocks.others"),
  date: DateStr,
  startMin: z.number().int().min(0).max(24 * 60),
  endMin: z.number().int().min(0).max(24 * 60),
  reasonId: z.uuid(),
  note: z.string().max(200).nullish(),
  allShops: z.boolean().optional(),
  confirm: z.boolean().optional().describe("Save even with clients booked in it (they stay booked)"),
});

// ───────────────────────────── Clients (ST-C4, ST-I5) ─────────────────────────────

export const ClientSearchQuery = z.object({ q: z.string().min(2).max(80).describe("Name, client number or the last 4 of a phone"), limit: z.coerce.number().int().min(1).max(20).optional() });
export const RevealBody = z.object({ field: z.string().max(80).describe("A masked field's key from the card (contact details are never revealed in the app)"), reason: z.string().min(3).max(200) });
export const ContactBody = z.object({ channel: z.enum(["sms", "call"]), message: z.string().max(480).optional().describe("The text, for sms") });

// ───────────────────────────── Timecards (ST-C5) ─────────────────────────────

const PeriodQ = DateStr.optional().describe("A pay period's first day; the current period when left out");
export const PeriodQuery = z.object({ period: PeriodQ });
export const TeamTimecardsQuery = z.object({ period: PeriodQ, shopId: z.uuid().optional() });
export const ExportQuery = z.object({ period: DateStr, format: z.enum(["isolved", "generic"]).optional(), shopId: z.uuid().optional() });
export const SignOffBody = z.object({ shopId: z.uuid(), periodStart: DateStr });
export const ApproveBody = SignOffBody.extend({ note: z.string().max(400).nullish().describe("Required when they haven't signed off") });
const PunchKind = z.enum(["in", "out", "break_start", "break_end"]);
const Reason = z.string().min(1).max(300).describe("Why; it goes in the edit log");
export const AddPunchBody = z.object({ shopId: z.uuid(), type: PunchKind, at: z.iso.datetime({ offset: true }), reason: Reason });
export const EditPunchBody = z.object({ at: z.iso.datetime({ offset: true }).optional(), type: PunchKind.optional(), shopId: z.uuid().optional(), reason: Reason });
export const VoidPunchBody = z.object({ reason: Reason });

// ───────────────────────────── Earnings and payouts (ST-C6, ST-C7, ST-C9) ─────────────────────────────

/** Always the signed-in employee's own: anything else in the query (a staffId, say) is 400, never quietly dropped. */
const MyPeriod = {
  period: z.string().max(10).optional().describe("current, or a pay period's id (its start date, from GET /me/pay-periods). The current period when nothing is sent"),
  periodId: z.string().max(10).optional().describe("A pay period's id: its start date. Same as period=<id>; send one or the other"),
  from: DateStr.optional().describe("With to, instead of a period"),
  to: DateStr.optional(),
};
/** My Earnings: the employee is the token's, so any other key (staffId and the like) is a 400. */
export const MyEarningsQuery = z.strictObject(MyPeriod);
export const MyTicketsQuery = z.strictObject({
  period: z.string().max(10).optional().describe("current, or a pay period's id; the same as periodId"),
  periodId: z.string().max(10).optional().describe("A pay period's id (its start date, from GET /me/pay-periods), or current. Send this, or from and to"),
  from: DateStr.optional().describe("With to, instead of periodId: a Chicago date range (up to 31 days)"),
  to: DateStr.optional(),
  date: DateStr.optional().describe("A Chicago (shop-local) calendar day inside that pay period or range: its tickets. Every ticket in the period or range when left out"),
});
export const MyReportQuery = z.strictObject({ ...MyPeriod, format: z.enum(["csv", "pdf"]).optional().describe("csv (the default) or pdf") });
export const NoQuery = z.strictObject({});
export const YtdQuery = z.strictObject({ year: z.coerce.number().int().min(2020).max(2100).optional() });
export const CutoverAnswerBody = z.object({ shopId: z.uuid(), status: z.enum(["confirmed", "disputed"]), note: z.string().max(500).nullish().describe("Required to dispute") });

// ───────────────────────────── Time off (ST-I1) ─────────────────────────────

export const TimeOffBody = z.object({
  shopId: z.uuid().nullable().describe("null for every shop they work at"),
  fromDate: DateStr,
  toDate: DateStr,
  allDay: z.boolean(),
  startMin: z.number().int().min(0).max(24 * 60).optional(),
  endMin: z.number().int().min(0).max(24 * 60).optional(),
  reasonId: z.uuid().describe("From GET /me/time-off-requests reasons"),
  note: z.string().max(200).nullish(),
  confirm: z.boolean().optional(),
});
export const TeamTimeOffQuery = z.object({ shopId: z.uuid().optional(), status: z.enum(["pending", "all"]).optional() });
export const DecisionBody = z.object({ decision: z.enum(["approve", "deny"]), note: z.string().max(400).nullish() });

// ───────────────────────────── Walk-ins, checkout, manager (ST-I3, ST-I4, ST-I7) ─────────────────────────────

export const WalkInBody = z.object({
  serviceId: z.uuid(),
  name: z.string().min(1).max(80),
  phone: z.string().max(40).nullish().describe("For the 'you're up' text; needs Client data's add permission"),
  preferredStaffId: z.uuid().nullish(),
  customerId: z.uuid().nullish(),
});
export const SeatBody = z.object({ staffId: z.uuid() });
export const EntryStatusBody = z.object({ status: z.enum(["left", "done"]) });
export const SaleBody = z.object({ appointmentId: z.uuid(), tipCents: z.number().int().min(0).max(100_000).optional().describe("For the card fee quote") });
export const TerminalTokenBody = z.object({ shopId: z.uuid().optional() });
export const BoardQuery = z.object({ shopId: z.uuid().optional() });

/** ST-I10: pay questions. */
export const PayQuestionBody = z.object({
  shopId: z.uuid(),
  periodStart: DateStr.nullish().describe("The pay period it's about, if any"),
  topic: z.enum(PAY_QUESTION_TOPICS),
  detail: z.string().min(1).max(PAY_QUESTION_MAX_CHARS).describe("What looks wrong"),
});
export const PayQuestionEscalateBody = z.object({ note: z.string().max(PAY_QUESTION_MAX_CHARS).nullish().describe("Why the answer didn't settle it") });
export const PayQuestionAnswerBody = z.object({ answer: z.string().min(1).max(PAY_QUESTION_MAX_CHARS) });
export const TeamPayQuestionsQuery = z.object({ open: z.enum(["true", "false"]).optional().describe("true: only the ones not closed") });

// ───────────────────────────── The app's contract (mobile packages/mock-api) ─────────────────────────────

export const APP_APPOINTMENT_STATUSES = ["booked", "confirmed", "checked_in", "in_service", "completed", "cancelled", "no_show"] as const;
export const AppStatusBody = z
  .object({
    action: StatusBody.shape.action.optional(),
    status: z.enum(APP_APPOINTMENT_STATUSES).optional().describe("The status to move it to, instead of action: checked_in, in_service, completed, no_show, cancelled, confirmed, or booked to undo"),
  })
  .refine((v) => !!v.action !== !!v.status, "Send action or status");
export const AppStepUpBody = StepUpBody.extend({
  pin: z.string().max(12).optional().describe("The 6-digit code from their authenticator app, as the app's step-up screen sends it. Never the time clock PIN"),
});
export const CashTipBody = z.object({
  shopId: z.uuid(),
  amountCents: z.number().int().min(0).max(1_000_000),
  originalDate: DateStr.describe("The day they got the tips; not in the future"),
  attestation: z.boolean().describe("They checked the attestation from GET /tips/declarations rules"),
  replacesId: z.uuid().nullish().describe("Correcting one of their declarations: same shop and day"),
  reason: z.string().trim().max(300).nullish().describe("Required with replacesId"),
});
export const AppDeviceBody = z.object({
  token: z.string().min(8).max(4096),
  platform: z.enum(["ios", "android"]).optional().describe("X-Client when left out, else ios"),
  provider: z.enum(["apns", "fcm", "expo"]).optional().describe("expo when left out"),
  appVersion: z.string().max(40).nullish(),
  osVersion: z.string().max(40).nullish(),
  reminders: z.boolean().optional().describe("Pushes about their own clients' bookings; the same as pushEnabled"),
  marketing: z.boolean().optional().describe("Ignored: staff get no marketing pushes"),
});
export const InstantQuoteBody = z.object({ amountCents: z.number().int().min(1).max(1_000_000) });
export const PayoutPreferencesBody = z.object({
  instantOptIn: z.boolean(),
  acceptInstantFee: z.string().max(200).nullish().describe("Turning instant on where the brand asks: the fee text shown (GET /banking instant.fee.terms), exactly"),
});
export const PayoutSessionCompleteBody = z.object({ state: z.string().max(40).optional().describe("Ignored: the state is read from Stripe") });
export const KioskRequestBody = z.object({ shopId: z.uuid(), label: z.string().max(60).optional().describe("Front desk when left out") });
export const KioskApproveBody = z.object({ deviceId: z.string().min(8).max(128).optional().describe("This install's own random id, to bind the credential to it; send it as X-Device-Id on each kiosk call then") });
export const KioskQrQuery = z.object({ shopId: z.uuid().optional().describe("The kiosk's own shop; any other is 404") });
export const KioskPinBody = z.object({
  staffId: z.uuid(),
  pin: z.string().max(12),
  direction: z.enum(["in", "out"]).optional().describe("in when left out"),
  cashTipCents: z.number().int().min(0).max(1_000_000).optional().describe("Not taken on the kiosk: declare cash tips on their own phone (POST /me/cash-tips)"),
  attestation: z.boolean().optional(),
});
export const KioskUnlockBody = z.object({ staffId: z.uuid(), kioskId: z.uuid() });
export const AuditQuery = z.object({ shopId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional().describe("50 when left out") });
