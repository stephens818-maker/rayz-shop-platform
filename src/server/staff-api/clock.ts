import "server-only";
import { and, asc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, staffShops, timePunches } from "@/db/schema";
import { OFFLINE_PUNCH_CLOCK_SKEW_MS, queuedPunchProblem } from "@/domain/staff-device-policy";
import { clockRuleText } from "@/domain/time-clock";
import { clientIp } from "@/lib/client-ip";
import { startOfLocalDay, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { assertShopAccess, can, openShops } from "@/server/auth/staff";
import { breakReasons } from "@/server/block-reasons";
import { clockProofUrl, clockQrCode } from "@/server/clock-codes";
import { AppError, forbidden } from "@/server/errors";
import { clockInWelcome } from "@/server/milestones/day";
import { redeemPairing, pairedDevice } from "@/server/clock-pairing";
import { PunchResult, checkPin, clockState, deviceFromToken, onShopTeam, punch, registerDevice, setPin, shopClocks } from "@/server/time-clock";
import { declarationRules, declareAtClockOut } from "@/server/tips/declarations";
import { kioskQueue } from "./front";
import type { StaffAppContext } from "./http";

/**
 * The time clock in the staff app (S2). A phone punch proves where it is the way the shop asks:
 * the front-desk QR code (it changes every 30 seconds), the shop's NFC sticker, the shop's Wi-Fi or
 * location. Both codes open `/admin/clock?shop=…&qr=…` (or `&tag=…`); the app reads `shop` and `qr`
 * or `tag` from that link and sends them as `proof`. A tablet registered as the shop's front-desk
 * clock punches for anyone with their own PIN. Nothing biometric: no face or fingerprint is asked
 * for or kept (a shop's punch photo is kept for managers, never matched).
 */

export type PunchType = "in" | "out" | "break_start" | "break_end";

/** The X-Clock-Device header: this install's front-desk clock token, from POST /clock/kiosk/register. */
const deviceToken = (req: Request) => req.headers.get("x-clock-device")?.trim() || null;

async function myClockShops(ctx: StaffAppContext) {
  const team = await workShopIds(ctx.staff.id);
  const ids = [...new Set([...team, ...openShops(ctx).map((s) => s.id)])];
  const open = ids.length ? (await db.select({ id: shops.id }).from(shops).where(and(inArray(shops.id, ids), ne(shops.status, "archived")))).map((s) => s.id) : [];
  return { team, open };
}

const stateView = (s: Awaited<ReturnType<typeof clockState>>) => ({
  state: s.state,
  next: s.next,
  shift: s.shift ? { shopId: s.shift.shopId, shop: s.shift.shop, start: s.shift.start.toISOString(), breakStart: s.shift.breakStart?.toISOString() ?? null } : null,
  stale: s.stale ? { shop: s.stale.shop, start: s.stale.start.toISOString() } : null,
});

/** Where they stand, the shops they can punch at with each one's rule, today's punches, break reasons and whether their PIN is set. */
export async function clockOverview(ctx: StaffAppContext, now = new Date()) {
  const me = ctx.staff.id;
  const { team, open } = await myClockShops(ctx);
  const [state, clocks, today, [mine], reasons, tipRules] = await Promise.all([
    clockState(me, now),
    shopClocks(open),
    db
      .select({ id: timePunches.id, type: timePunches.type, at: timePunches.at, shopId: timePunches.shopId, shop: shops.name, method: timePunches.method, flags: timePunches.flags })
      .from(timePunches)
      .innerJoin(shops, eq(shops.id, timePunches.shopId))
      .where(and(eq(timePunches.staffId, me), gte(timePunches.at, startOfLocalDay(todayLocal(now))), isNull(timePunches.voidedAt)))
      .orderBy(asc(timePunches.at)),
    db.select({ pin: staff.clockPinHash, opensEarly: staff.clockOpensEarly }).from(staff).where(eq(staff.id, me)),
    breakReasons(ctx.currentShopId),
    declarationRules(),
  ]);
  return {
    ...stateView(state),
    defaultShopId: team.find((s) => open.includes(s)) ?? null,
    shops: clocks.map((c) => ({ id: c.id, name: c.name, methods: c.settings.methods, photo: c.settings.photo, rule: clockRuleText(c.settings) })),
    breakReasons: reasons,
    hasPin: !!mine?.pin,
    today: today.map((p) => ({ id: p.id, type: p.type, at: p.at.toISOString(), shopId: p.shopId, shop: p.shop, method: p.method, flags: p.flags })),
    canTimesheet: can(ctx, "timesheet.own"),
    /** Ask for today's cash tips when they clock out (send them as cashTips on the punch). */
    cashTips: tipRules.enabled && tipRules.atClockOut && can(ctx, "tips.own") ? { attestation: tipRules.attestation } : null,
  };
}

export interface AppPunchInput {
  shopId: string;
  type: PunchType;
  proof?: { qr?: string; tag?: string };
  gps?: { lat: number; lng: number; accuracyM: number | null } | null;
  photo?: string | null;
  confirmTimeOff?: boolean;
  breakReasonId?: string | null;
  plannedMin?: number | null;
  cashTips?: { cents: number; attest: boolean };
  /** ST-I18: when it was tapped with no signal, and the app's id for it. */
  queuedAt?: string;
  clientPunchId?: string;
}

const resultView = (r: PunchResult, welcome: Awaited<ReturnType<typeof clockInWelcome>> = null) =>
  r.kind === "confirm" ? r : { kind: r.kind, punchId: r.punchId, type: r.type, at: r.at.toISOString(), shop: r.shop, flags: r.flags, notes: r.notes, welcome };

/** The punch a retry already put in, as the first send returned it. */
async function sentBefore(staffId: string, clientPunchId: string) {
  const [p] = await db
    .select({ id: timePunches.id, type: timePunches.type, at: timePunches.at, flags: timePunches.flags, shop: shops.name })
    .from(timePunches)
    .innerJoin(shops, eq(shops.id, timePunches.shopId))
    .where(and(eq(timePunches.staffId, staffId), eq(timePunches.clientPunchId, clientPunchId)));
  return p ? { kind: "done" as const, punchId: p.id, type: p.type, at: p.at.toISOString(), shop: p.shop, flags: p.flags, notes: [], welcome: null, alreadySent: true } : null;
}

/**
 * A punch from their own phone. Clocking in returns their congratulations (milestones) to pop up.
 * ST-I18: one tapped with no signal comes with queuedAt and goes in at that time, flagged offline;
 * the shop's Wi-Fi can't prove it then (the phone has moved networks), NFC and location can. A QR
 * punch goes in at the server's time instead (see punch()).
 */
export async function appPunch(ctx: StaffAppContext, req: Request, v: AppPunchInput, now = new Date()) {
  assertShopAccess(ctx, v.shopId);
  if (v.clientPunchId) {
    const again = await sentBefore(ctx.staff.id, v.clientPunchId);
    if (again) return again;
  }
  const queuedAt = v.queuedAt ? new Date(v.queuedAt) : null;
  const late = queuedAt && queuedPunchProblem(queuedAt, now);
  if (late) throw new AppError("bad_request", late, { field: "queuedAt" });
  const offline = queuedAt && now.getTime() - queuedAt.getTime() > OFFLINE_PUNCH_CLOCK_SKEW_MS ? queuedAt : null;
  const device = await deviceFromToken(deviceToken(req));
  const r = await punch({
    staffId: ctx.staff.id,
    shopId: v.shopId,
    type: v.type,
    source: "self",
    evidence: { deviceShopId: device?.shopId ?? null, ip: offline ? null : clientIp(req.headers), gps: v.gps ?? null },
    proof: v.proof,
    deviceId: device?.shopId === v.shopId ? device.id : null,
    photo: v.photo ?? null,
    confirmTimeOff: v.confirmTimeOff,
    breakReasonId: v.breakReasonId ?? null,
    plannedMin: v.plannedMin ?? null,
    actor: { ...ctx.actor, label: `${ctx.actor.label} (staff app)` },
    now: offline ?? now,
    ...(offline ? { offline: { receivedAt: now } } : {}),
    clientPunchId: v.clientPunchId ?? null,
  });
  const view = resultView(r, r.kind === "done" && r.type === "in" ? await clockInWelcome(ctx.staff.id, ctx.actor, "clock") : null);
  // The punch stands either way; a declaration that can't be taken comes back as cashTips.error.
  if (r.kind !== "done" || r.type !== "out" || !v.cashTips || !can(ctx, "tips.own")) return view;
  return { ...view, cashTips: await declareAtClockOut({ staffId: ctx.staff.id, shopId: v.shopId, cents: v.cashTips.cents, attested: v.cashTips.attest, actor: ctx.actor }) };
}

export async function setMyPin(ctx: StaffAppContext, pin: string) {
  await setPin(ctx.staff.id, pin, ctx.actor);
  return { hasPin: true };
}

// ───────────────────────────── The shop's front-desk clock ─────────────────────────────

/** Makes this install one of a shop's front-desk clocks. The token is shown once; the app keeps it and sends it as X-Clock-Device. */
export async function registerKiosk(ctx: StaffAppContext, shopId: string, label: string) {
  assertShopAccess(ctx, shopId);
  return registerDevice(shopId, label, ctx.actor);
}

/**
 * POST /clock/kiosk/pair, with no staff sign-in: a manager's pairing code makes this install a
 * front-desk clock. The token works only with this install's id (X-Device-Id on each kiosk call).
 */
export async function pairKiosk(req: Request, v: { code: string; deviceId: string }) {
  const r = await redeemPairing({ code: v.code, installId: v.deviceId, ip: clientIp(req.headers) });
  return { token: r.token, device: r.device };
}

/** Who is running the front-desk clock: the paired device on its own, or a signed-in login with the clock permission on a registered one. */
export interface KioskCaller {
  device: { id: string; shopId: string; label: string; shop: string };
  by: string;
  queue: boolean;
}

/** A paired install's X-Clock-Device and X-Device-Id: the clock runs with no staff token. */
export async function pairedKiosk(req: Request): Promise<KioskCaller | null> {
  const device = await pairedDevice(deviceToken(req), req.headers.get("x-device-id"));
  return device && { device, by: `kiosk:${device.label} (staff app)`, queue: true };
}

/** The registered front-desk clock this request comes from, at one of the signed-in login's shops. */
export async function signedInKiosk(ctx: StaffAppContext, req: Request): Promise<KioskCaller> {
  const device = await deviceFromToken(deviceToken(req));
  if (!device || !ctx.shopIds.includes(device.shopId)) throw forbidden("This device isn't registered as one of your shops' time clocks.");
  assertShopAccess(ctx, device.shopId);
  return { device, by: `kiosk:${device.label} (${ctx.staff.displayLabel}, staff app)`, queue: can(ctx, "walkins.manage") || ctx.staff.kind === "shop" };
}

/** The QR code the front-desk clock shows for phones to scan: the link to draw, good for about a minute. */
export async function kioskQr({ device }: KioskCaller) {
  const { code, expiresAt } = clockQrCode(device.shopId);
  return { shopId: device.shopId, url: clockProofUrl(device.shopId, { qr: code }), expiresAt: expiresAt.toISOString() };
}

/** Who can punch on this clock: the shop's active team, by the name they go by. */
export async function kioskTeam({ device }: KioskCaller) {
  const team = await db
    .select({ id: staff.id, name: staff.displayLabel })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, device.shopId), eq(staff.active, true), eq(staff.kind, "person")))
    .orderBy(asc(staff.displayLabel));
  return { shopId: device.shopId, shop: device.shop, device: device.label, team };
}

/** Their PIN, then what they can punch next. Five wrong PINs lock theirs for five minutes. */
export async function kioskStatus({ device }: KioskCaller, v: { staffId: string; pin: string }) {
  await onShopTeam(device.shopId, v.staffId);
  await checkPin(v.staffId, v.pin);
  return stateView(await clockState(v.staffId));
}

export async function kioskPunch(k: KioskCaller, req: Request, v: { staffId: string; pin: string; type: PunchType; photo?: string | null; confirmTimeOff?: boolean; breakReasonId?: string | null; plannedMin?: number | null }) {
  const { device } = k;
  await onShopTeam(device.shopId, v.staffId);
  await checkPin(v.staffId, v.pin);
  const actor = { staffId: v.staffId, label: k.by };
  const r = await punch({
    staffId: v.staffId,
    shopId: device.shopId,
    type: v.type,
    source: "kiosk",
    evidence: { deviceShopId: device.shopId, ip: clientIp(req.headers), gps: null },
    deviceId: device.id,
    photo: v.photo ?? null,
    confirmTimeOff: v.confirmTimeOff,
    breakReasonId: v.breakReasonId ?? null,
    plannedMin: v.plannedMin ?? null,
    actor,
  });
  return resultView(r, r.kind === "done" && r.type === "in" ? await clockInWelcome(v.staffId, actor, "kiosk") : null);
}

/** The walk-in queue on the front-desk device: first names and waits only. */
export async function kioskQueueView(k: KioskCaller) {
  if (!k.queue) throw forbidden("The walk-in queue needs a shop login or walk-in management");
  return kioskQueue(k.device.shopId);
}

/** Everything the front-desk screen draws in one call: the rotating QR, the PIN pad's team and the walk-in queue. */
export async function kioskHome(k: KioskCaller) {
  const [qr, team, queue] = await Promise.all([kioskQr(k), kioskTeam(k), k.queue ? kioskQueue(k.device.shopId) : null]);
  return { shopId: k.device.shopId, shop: k.device.shop, device: k.device.label, qr: { url: qr.url, expiresAt: qr.expiresAt }, team: team.team, queue };
}
