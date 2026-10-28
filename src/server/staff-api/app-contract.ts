import "server-only";
import { and, asc, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, clockDevices, shops, staff, staffAppTokens, staffShops, timePunches } from "@/db/schema";
import { canCharge } from "@/domain/connect";
import { GROSS_LABEL, LATE_DECLARATION_COPY, TAX_NOTE } from "@/domain/my-earnings";
import { shopClockSettings } from "@/domain/time-clock";
import { demoMode } from "@/lib/deployment";
import { flags } from "@/lib/flags";
import { formatCents } from "@/lib/money";
import { PdfDoc, fitText } from "@/lib/pdf";
import { SHOP_TZ } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { stepUp } from "@/server/auth/sign-in-guard";
import { can } from "@/server/auth/staff";
import { signToken } from "@/server/auth/tokens";
import { approvePairing, pairedDevice, startPairing } from "@/server/clock-pairing";
import { QR_STEP_MS } from "@/server/clock-codes";
import { AppError, forbidden, notFound } from "@/server/errors";
import { settlementAccount } from "@/server/payments/connect";
import { tipToBarberShops } from "@/server/payments/settlement";
import { onShopTeam, revokeDevice, unlockPin } from "@/server/time-clock";
import { staffMfaOn, type StaffLoginResult } from "./auth";
import { KioskCaller, kioskPunch, kioskQr } from "./clock";
import { type staffAppConfig } from "./config";
import { firstNameOnly, myEarnings } from "./earnings";
import type { StaffAppContext } from "./http";

/**
 * The staff app's own names for core's /api/staff/v1 (the mobile repo's packages/mock-api, PR #7):
 * the same server code and rules as the routes they sit beside, with the fields the app reads.
 * Everything here is additive: no existing field changes meaning.
 */

export const STAFF_APP_NAME = "Ray'z Staff";
/** Payroll workweeks start on Sunday (weekStartOf in the overtime rules). */
export const WEEK_START_DAY = 0;
const CLOSED_COPY = "This shop isn't open in the app yet.";
const STEP_UP_SECONDS = 15 * 60;

// ───────────────────────────── GET /config ─────────────────────────────

/**
 * Each shop's switches for the app, before sign-in: launched (live), booking (native, external with
 * its link, or closed), payments (cards can be taken: its Stripe account can charge, or the brand
 * takes them), clockIn (the app's clock is on and the shop takes a phone punch) and tipTransfers
 * (FEATURE_TIP_TO_BARBER and the shop's Tips to barbers switch).
 */
export async function shopGates(clockOn: boolean) {
  const rows = await db
    .select({
      id: shops.id,
      slug: shops.slug,
      status: shops.status,
      closedUntil: shops.closedUntil,
      closedNote: shops.closedNote,
      bookingEnabled: shops.bookingEnabled,
      bookingMode: shops.bookingMode,
      externalBookingUrl: shops.externalBookingUrl,
      paymentsMode: shops.paymentsMode,
      ownerEntityId: shops.ownerEntityId,
      timeClock: shops.timeClock,
      isDemo: shops.isDemo,
    })
    .from(shops)
    .where(ne(shops.status, "archived"))
    .orderBy(asc(shops.name));
  const shown = demoMode() ? rows : rows.filter((s) => !s.isDemo);
  const tips = await tipToBarberShops(shown.map((s) => s.id));
  return Promise.all(
    shown.map(async (s) => {
      const launched = s.status === "live";
      const booking = s.bookingMode === "external" && s.externalBookingUrl ? ("external" as const) : launched && s.bookingEnabled ? ("native" as const) : ("closed" as const);
      const payments = launched && (s.paymentsMode === "brand" || (s.paymentsMode !== "cash_only" && canCharge(await settlementAccount(s))));
      return {
        id: s.id,
        shopId: s.id,
        slug: s.slug,
        launched,
        launchAt: s.status === "closed" ? s.closedUntil : null,
        closedCopy: launched ? null : s.closedNote || CLOSED_COPY,
        booking,
        externalBookingUrl: booking === "external" ? s.externalBookingUrl : null,
        payments,
        clockIn: clockOn && launched && shopClockSettings(s.timeClock).methods.length > 0,
        tipTransfers: tips.has(s.id),
      };
    }),
  );
}

/** The app's StaffConfig fields, from the same settings as the rest of GET /config. */
export async function appConfigFields(cfg: ReturnType<typeof staffAppConfig>) {
  const v = (p: { minVersion: string | null; latestVersion: string | null }) => ({ min: p.minVersion ?? "0.0.0", latest: p.latestVersion ?? p.minVersion ?? "0.0.0" });
  const ios = v(cfg.platforms.ios);
  const android = v(cfg.platforms.android);
  return {
    timezone: SHOP_TZ,
    timeFormat: cfg.display.timeFormat,
    weekStartDay: WEEK_START_DAY,
    appName: STAFF_APP_NAME,
    minSupportedVersion: { ios: ios.min, android: android.min },
    latestVersion: { ios: ios.latest, android: android.latest },
    tipTransfersDefault: flags.tipToBarber(),
    supportPhone: cfg.support.phone,
    supportEmail: cfg.support.email,
    privacyUrl: cfg.links.privacy,
    termsUrl: cfg.links.terms,
    shops: await shopGates(cfg.features.clock),
  };
}

// ───────────────────────────── Sign-in ─────────────────────────────

/** Where the code went, from what they typed (never from the record, so the answer still doesn't say whether they're on file). */
export function maskedDestination(v: { email?: string | null; phone?: string | null }) {
  if (v.phone) {
    const d = v.phone.replace(/\D/g, "");
    return d.length >= 4 ? `•••-•••-${d.slice(-4)}` : null;
  }
  const [user, host] = (v.email ?? "").trim().split("@");
  return user && host ? `${user[0]}•••@${host}` : null;
}

/** POST /auth/otp/verify: the tokens flat, with who signed in (first name and shop ids). Two-step sign-in still answers { twoFactor }. */
export async function otpVerifyView(r: StaffLoginResult) {
  if (!("tokens" in r)) return r;
  const t = r.tokens;
  const [me] = await db
    .select({ id: staff.id, firstName: staff.firstName })
    .from(staffAppTokens)
    .innerJoin(staff, eq(staff.id, staffAppTokens.staffId))
    .where(eq(staffAppTokens.sessionId, t.sessionId))
    .limit(1);
  return {
    ...r,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    tokenType: t.tokenType,
    expiresIn: t.expiresIn,
    staff: me ? { id: me.id, firstName: me.firstName, shops: await workShopIds(me.id) } : null,
  };
}

/**
 * POST /auth/step-up: POST /me/step-up under the app's name. pin is read as their authenticator code
 * (it is never the time clock PIN); a code is this session's MFA for My Earnings, which the server
 * keeps on the session, so stepUpToken is only a receipt the app may send back as X-Step-Up. Where
 * MFA isn't enforced (the demo) nothing is checked and required is false.
 */
export async function appStepUp(ctx: StaffAppContext, v: { password?: string; code?: string; pin?: string }) {
  const stepUpToken = await signToken({ sub: ctx.staff.id, sid: ctx.sessionId }, "staff_app_step_up", STEP_UP_SECONDS);
  if (!staffMfaOn() || ctx.staff.demo) return { stepUpToken, expiresIn: STEP_UP_SECONDS, required: false };
  const r = await stepUp(ctx, { password: v.password, code: v.code ?? v.pin });
  return { ...r, stepUpToken, expiresIn: STEP_UP_SECONDS, required: true };
}

// ───────────────────────────── The clock ─────────────────────────────

const ShopId = z.uuid();

/** The shop and proof in a scanned front-desk QR code or NFC sticker link (/admin/clock?shop=…&qr=… or &tag=…). */
export function clockFromToken(raw: string): { shopId: string; proof: { qr: string } | { tag: string } } | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), "https://clock.invalid");
  } catch {
    return null;
  }
  const shopId = url.searchParams.get("shop");
  const qr = url.searchParams.get("qr");
  const tag = url.searchParams.get("tag");
  if (!shopId || !ShopId.safeParse(shopId).success) return null;
  if (qr && qr.length <= 64) return { shopId, proof: { qr } };
  if (tag && tag.length <= 64) return { shopId, proof: { tag } };
  return null;
}

export const EXPIRED_CODE = "That shop code expired. Scan the code at the shop again.";

/** The shift a punch belongs to, as the app keeps it: when it started and ended, and the cash tips declared at clock-out. Null for a break or a punch that needs confirming. */
export async function punchRecord(staffId: string, view: { kind: string; punchId?: string }, declared?: { amountCents: number } | null) {
  if (view.kind !== "done" || !view.punchId) return null;
  const [p] = await db.select({ id: timePunches.id, type: timePunches.type, at: timePunches.at, shopId: timePunches.shopId }).from(timePunches).where(eq(timePunches.id, view.punchId));
  if (!p || (p.type !== "in" && p.type !== "out")) return null;
  if (p.type === "in") return { id: p.id, staffId, shopId: p.shopId, inAt: p.at.toISOString(), outAt: null, cashTipCents: null, attestation: false };
  const [start] = await db
    .select({ id: timePunches.id, at: timePunches.at })
    .from(timePunches)
    .where(and(eq(timePunches.staffId, staffId), eq(timePunches.shopId, p.shopId), eq(timePunches.type, "in"), lt(timePunches.at, p.at), isNull(timePunches.voidedAt)))
    .orderBy(desc(timePunches.at))
    .limit(1);
  return { id: start?.id ?? p.id, staffId, shopId: p.shopId, inAt: start?.at.toISOString() ?? null, outAt: p.at.toISOString(), cashTipCents: declared?.amountCents ?? null, attestation: !!declared };
}

// ───────────────────────────── Calendar and appointments ─────────────────────────────

type CalendarColumn = { staffId: string; appts: readonly { id: string; startsAt: string; customerId: string | null; customerName: string; services: readonly string[]; status: string }[] };

/** Their own appointments on the day, as the app's Today list shows them: the client's first name only. */
export const calendarAppointments = (columns: readonly CalendarColumn[], me: string) =>
  columns
    .filter((c) => c.staffId === me)
    .flatMap((c) => c.appts.map((a) => ({ id: a.id, startsAt: a.startsAt, clientId: a.customerId, clientFirstName: firstNameOnly(a.customerName), serviceName: a.services.join(", "), status: a.status })));

/** The app sends the status to move to; core's calendar takes the action that gets there. */
export const ACTION_FOR_STATUS = { booked: "undo", confirmed: "confirm", checked_in: "check_in", in_service: "start", completed: "complete", cancelled: "cancel", no_show: "no_show" } as const;

// ───────────────────────────── My Earnings report ─────────────────────────────

export const REPORT_COLUMNS = [
  "period_start",
  "period_end",
  "payroll_status",
  "production_hours",
  "training_hours",
  "training_pay_cents",
  "hourly_pay_cents",
  "service_commission_cents",
  "product_commission_cents",
  "top_up_cents",
  "greater_of_cents",
  "ot_estimated_cents",
  "card_tips_cents",
  "cash_tips_cents",
  "gross_total_cents",
] as const;

type Earnings = Awaited<ReturnType<typeof myEarnings>>;
const csvCell = (v: string | number | null) => (v === null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function reportRow(e: Earnings): (string | number | null)[] {
  const status = e.periods.length ? e.periods.map((p) => p.payrollStatus).join("|") : e.payrollStatus;
  return [
    e.from,
    e.to,
    status,
    e.productionHours,
    e.trainingHours,
    e.trainingPayCents,
    e.hourlyPayCents,
    e.serviceCommissionCents,
    e.productCommissionCents,
    e.topUpCents,
    e.greaterOfCents,
    e.otEstimatedCents,
    e.cardTipsCents,
    e.cashTipsCents,
    e.totalCents,
  ];
}

function reportPdf(e: Earnings, firstName: string): Uint8Array {
  const doc = new PdfDoc();
  const left = 54;
  const right = 612 - 54;
  const row = reportRow(e);
  const money = (v: string | number | null) => (typeof v === "number" ? formatCents(v) : "-");
  const hours = (v: string | number | null) => (typeof v === "number" ? v.toFixed(2) : "-");
  doc.text(left, 60, fitText(`${firstName}'s earnings, ${e.from} to ${e.to}`, right - left, 16, true), { size: 16, bold: true });
  doc.text(left, 80, fitText(GROSS_LABEL, right - left, 9), { size: 9, gray: 0.35 });
  doc.text(left, 94, fitText(TAX_NOTE, right - left, 8), { size: 8, gray: 0.45 });
  const lines: [string, string][] = [
    ["Payroll status", String(row[2] ?? "-").replace(/_/g, " ")],
    ["Production hours", hours(row[3])],
    ["Training hours", hours(row[4])],
    ["Training pay", money(row[5])],
    ["Hourly pay", money(row[6])],
    ["Service commission", money(row[7])],
    ["Product commission", money(row[8])],
    ["Top-up to the greater of", money(row[9])],
    ["Greater of hourly or commission", money(row[10])],
    ["Overtime (estimated)", money(row[11])],
    ["Card tips", money(row[12])],
    ["Cash tips", money(row[13])],
    ["Gross total", money(row[14])],
  ];
  let y = 128;
  for (const [label, value] of lines) {
    const total = label === "Gross total";
    if (total) doc.line(left, y - 12, right, y - 12);
    doc.text(left, y, label, { size: 11, bold: total });
    doc.text(right, y, value, { size: 11, bold: total, align: "right" });
    y += 20;
  }
  return doc.toBytes();
}

/**
 * GET /me/earnings/report?format=csv|pdf: their own My Earnings for a pay period or whole workweeks,
 * gross only, as a file. A from/to that cuts a workweek is refused: overtime is worked out a week at a time.
 */
export async function earningsReport(ctx: StaffAppContext, q: { period?: string; periodId?: string; from?: string; to?: string; format?: "csv" | "pdf" }) {
  const { format = "csv", ...period } = q;
  const e = await myEarnings(ctx, period);
  if (e.range && !e.range.wholeWorkweeks) throw new AppError("bad_request", "Export a whole workweek.", { field: "from", partialWeeks: e.range.partialWeeks });
  const name = `earnings-${e.from}-to-${e.to}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${name}"` };
  if (format === "pdf") return new Response(Buffer.from(reportPdf(e, ctx.staff.firstName)), { headers: { ...headers, "Content-Type": "application/pdf" } });
  const csv = [GROSS_LABEL, REPORT_COLUMNS.join(","), reportRow(e).map(csvCell).join(",")].join("\n") + "\n";
  return new Response(csv, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
}

/** POST /me/cash-tips: a cash tip declaration as the app's adjustment row. */
export const cashTipAdjustment = (d: { id: string; shopId: string; businessDate: string; postedDate: string; late: boolean; amountCents: number; replacesId: string | null }) => ({
  id: d.id,
  kind: d.late ? ("late_declaration" as const) : ("declaration" as const),
  shopId: d.shopId,
  amountCents: d.amountCents,
  originalDate: d.businessDate,
  postedDate: d.postedDate,
  lateDeclaration: d.late,
  reducesPay: false as const,
  copy: d.late ? LATE_DECLARATION_COPY : null,
  replacesId: d.replacesId,
});

export const ON_DEMAND_OFF =
  "Cashing out on demand isn't offered yet. Turn on instant payouts and each approved tip payout goes to your debit card within about 30 minutes.";

// ───────────────────────────── The kiosk ─────────────────────────────

const KIOSK_ACTIONS = ["timeclock.pairing_start", "kiosk.approve", "timeclock.device_pair", "timeclock.device_revoke", "timeclock.device_register", "timeclock.pin_unlock", "timeclock.pin_clear"];
export const KIOSK_CASH_TIPS = "Cash tips aren't taken on the kiosk. Declare them in the app on your phone.";

/** A kiosk call with its credential as the Bearer token (or X-Clock-Device): a paired front-desk clock, with no staff sign-in. */
export async function bearerKiosk(req: Request): Promise<KioskCaller> {
  const raw = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || req.headers.get("x-clock-device")?.trim() || "";
  if (!raw) throw new AppError("unauthorized", "Sign in required");
  const device = await pairedDevice(raw, req.headers.get("x-device-id"));
  if (device) return { device, by: `kiosk:${device.label} (staff app)`, queue: true };
  if (raw.split(".").length === 3) throw forbidden("Enter your PIN on the shop kiosk.");
  throw new AppError("unauthorized", "This device isn't paired.", { reason: "kiosk_not_paired" });
}

const kioskManager = (ctx: StaffAppContext) => {
  if (!can(ctx, "settings.shop")) throw forbidden("A manager has to approve this kiosk.");
};

/** POST /kiosk/pair: a manager signed in on the tablet asks to make it the shop's front-desk clock (a pairing code under the hood, good for 10 minutes). */
export async function requestKiosk(ctx: StaffAppContext, v: { shopId: string; label?: string }) {
  kioskManager(ctx);
  const p = await startPairing({ actor: ctx.actor, shopIds: ctx.shopIds }, v.shopId, v.label?.trim() || "Front desk");
  return { requestId: p.id, shopId: v.shopId, status: "pending" as const, expiresAt: p.expiresAt, code: p.code, url: p.url };
}

/** POST /kiosk/pair/{id}/approve: the credential, shown once; the tablet keeps it and sends it as its Bearer token. */
export async function approveKiosk(ctx: StaffAppContext, requestId: string, v: { deviceId?: string }) {
  kioskManager(ctx);
  const r = await approvePairing({ actor: ctx.actor, shopIds: ctx.shopIds }, requestId, v.deviceId);
  return { kioskId: r.device.id, credential: r.token, shopId: r.device.shopId, device: r.device };
}

/** POST /kiosk/{id}/revoke: the credential stops working at once. */
export async function revokeKiosk(ctx: StaffAppContext, id: string) {
  kioskManager(ctx);
  await revokeDevice(id, ctx.shopIds, ctx.actor);
  return { kioskId: id, revoked: true };
}

/** GET /kiosk/roster: who can punch on this clock, by first name. No photos are kept for it. */
export async function kioskRoster({ device }: KioskCaller) {
  const team = await db
    .select({ id: staff.id, firstName: staff.firstName })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, device.shopId), eq(staff.active, true), eq(staff.kind, "person")))
    .orderBy(asc(staff.firstName));
  return { shopId: device.shopId, shop: device.shop, staff: team.map((t) => ({ id: t.id, firstName: t.firstName, photoUrl: null })) };
}

/** GET /kiosk/qr: the code phones scan to punch. token is the link to draw; the app sends it back as it scanned it. */
export async function kioskQrToken(k: KioskCaller, shopId?: string) {
  if (shopId && shopId !== k.device.shopId) throw notFound("Shop");
  const q = await kioskQr(k);
  return { token: q.url, url: q.url, expiresAt: q.expiresAt, shopId: k.device.shopId, kioskId: k.device.id, rotatesSeconds: QR_STEP_MS / 1000 };
}

/** POST /kiosk/pin: their PIN, then the punch (in when direction is left out). */
export async function kioskPinPunch(k: KioskCaller, req: Request, v: { staffId: string; pin: string; direction?: "in" | "out"; cashTipCents?: number }) {
  const view = await kioskPunch(k, req, { staffId: v.staffId, pin: v.pin, type: v.direction ?? "in" });
  return { ...view, punch: await punchRecord(v.staffId, view), ...(v.cashTipCents ? { cashTips: { declared: null, error: KIOSK_CASH_TIPS } } : {}) };
}

/** POST /kiosk/pin/unlock: a manager lifts a PIN lock early, for someone on that kiosk's shop team (not themselves). */
export async function unlockKioskPin(ctx: StaffAppContext, v: { staffId: string; kioskId: string }) {
  if (!can(ctx, "timesheet.edit")) throw forbidden("A manager has to unlock this PIN.");
  const [d] = await db.select({ id: clockDevices.id, shopId: clockDevices.shopId }).from(clockDevices).where(and(eq(clockDevices.id, v.kioskId), isNull(clockDevices.revokedAt)));
  if (!d || !ctx.shopIds.includes(d.shopId)) throw notFound("Kiosk");
  if (v.staffId === ctx.staff.id) throw forbidden("Ask another manager to unlock your own PIN.");
  await onShopTeam(d.shopId, v.staffId);
  await unlockPin(v.staffId, ctx.actor, d.shopId);
  return { unlocked: true, staffId: v.staffId, kioskId: d.id };
}

/** GET /audit: the kiosk entries (pairing, approvals, revokes, PIN unlocks) at their shops, newest first. */
export async function kioskAudit(ctx: StaffAppContext, q: { shopId?: string; limit?: number }) {
  kioskManager(ctx);
  const ids = q.shopId ? ctx.shopIds.filter((s) => s === q.shopId) : ctx.shopIds;
  if (!ids.length) return { entries: [] };
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(inArray(auditLog.shopId, [...ids]), inArray(auditLog.action, KIOSK_ACTIONS)))
    .orderBy(desc(auditLog.at))
    .limit(q.limit ?? 50);
  return {
    entries: rows.map((r) => ({ id: r.id, at: r.at.toISOString(), actorStaffId: r.actorStaffId, actorLabel: r.actorLabel, shopId: r.shopId, action: r.action, entity: r.entity, entityId: r.entityId, details: r.details })),
  };
}
