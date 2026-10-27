import "server-only";
import { and, asc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, staffShops, timePunches } from "@/db/schema";
import { clockRuleText } from "@/domain/time-clock";
import { clientIp } from "@/lib/client-ip";
import { startOfLocalDay, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { assertShopAccess, can, openShops } from "@/server/auth/staff";
import { breakReasons } from "@/server/block-reasons";
import { clockProofUrl, clockQrCode } from "@/server/clock-codes";
import { forbidden, notFound } from "@/server/errors";
import { clockInWelcome } from "@/server/milestones/day";
import { PunchResult, checkPin, clockState, deviceFromToken, punch, registerDevice, setPin, shopClocks } from "@/server/time-clock";
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
  const [state, clocks, today, [mine], reasons] = await Promise.all([
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
  ]);
  return {
    ...stateView(state),
    defaultShopId: team.find((s) => open.includes(s)) ?? null,
    shops: clocks.map((c) => ({ id: c.id, name: c.name, methods: c.settings.methods, photo: c.settings.photo, rule: clockRuleText(c.settings) })),
    breakReasons: reasons,
    hasPin: !!mine?.pin,
    today: today.map((p) => ({ id: p.id, type: p.type, at: p.at.toISOString(), shopId: p.shopId, shop: p.shop, method: p.method, flags: p.flags })),
    canTimesheet: can(ctx, "timesheet.own"),
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
}

const resultView = (r: PunchResult, welcome: Awaited<ReturnType<typeof clockInWelcome>> = null) =>
  r.kind === "confirm" ? r : { kind: r.kind, punchId: r.punchId, type: r.type, at: r.at.toISOString(), shop: r.shop, flags: r.flags, notes: r.notes, welcome };

/** A punch from their own phone. Clocking in returns their congratulations (milestones) to pop up. */
export async function appPunch(ctx: StaffAppContext, req: Request, v: AppPunchInput) {
  assertShopAccess(ctx, v.shopId);
  const device = await deviceFromToken(deviceToken(req));
  const r = await punch({
    staffId: ctx.staff.id,
    shopId: v.shopId,
    type: v.type,
    source: "self",
    evidence: { deviceShopId: device?.shopId ?? null, ip: clientIp(req.headers), gps: v.gps ?? null },
    proof: v.proof,
    deviceId: device?.shopId === v.shopId ? device.id : null,
    photo: v.photo ?? null,
    confirmTimeOff: v.confirmTimeOff,
    breakReasonId: v.breakReasonId ?? null,
    plannedMin: v.plannedMin ?? null,
    actor: { ...ctx.actor, label: `${ctx.actor.label} (staff app)` },
  });
  return resultView(r, r.kind === "done" && r.type === "in" ? await clockInWelcome(ctx.staff.id, ctx.actor, "clock") : null);
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

/** The registered front-desk clock this request comes from, at one of the signed-in login's shops. */
async function kiosk(ctx: StaffAppContext, req: Request) {
  const device = await deviceFromToken(deviceToken(req));
  if (!device || !ctx.shopIds.includes(device.shopId)) throw forbidden("This device isn't registered as one of your shops' time clocks.");
  assertShopAccess(ctx, device.shopId);
  return device;
}

/** The QR code the front-desk clock shows for phones to scan: the link to draw, good for about a minute. */
export async function kioskQr(ctx: StaffAppContext, req: Request) {
  const device = await kiosk(ctx, req);
  const { code, expiresAt } = clockQrCode(device.shopId);
  return { shopId: device.shopId, url: clockProofUrl(device.shopId, { qr: code }), expiresAt: expiresAt.toISOString() };
}

/** Who can punch on this clock: the shop's active team, by the name they go by. */
export async function kioskTeam(ctx: StaffAppContext, req: Request) {
  const device = await kiosk(ctx, req);
  const team = await db
    .select({ id: staff.id, name: staff.displayLabel })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, device.shopId), eq(staff.active, true), eq(staff.kind, "person")))
    .orderBy(asc(staff.displayLabel));
  return { shopId: device.shopId, shop: device.shop, device: device.label, team };
}

/** Only the shop's own team punches on its clock; anyone else is not found, so ids can't be probed. */
async function onTeam(shopId: string, staffId: string) {
  const [r] = await db
    .select({ id: staff.id })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), eq(staffShops.staffId, staffId), eq(staff.active, true), eq(staff.kind, "person")))
    .limit(1);
  if (!r) throw notFound("Team member");
}

/** Their PIN, then what they can punch next. Five wrong PINs lock theirs for five minutes. */
export async function kioskStatus(ctx: StaffAppContext, req: Request, v: { staffId: string; pin: string }) {
  const device = await kiosk(ctx, req);
  await onTeam(device.shopId, v.staffId);
  await checkPin(v.staffId, v.pin);
  return stateView(await clockState(v.staffId));
}

export async function kioskPunch(ctx: StaffAppContext, req: Request, v: { staffId: string; pin: string; type: PunchType; photo?: string | null; confirmTimeOff?: boolean; breakReasonId?: string | null; plannedMin?: number | null }) {
  const device = await kiosk(ctx, req);
  await onTeam(device.shopId, v.staffId);
  await checkPin(v.staffId, v.pin);
  const actor = { staffId: v.staffId, label: `kiosk:${device.label} (${ctx.staff.displayLabel}, staff app)` };
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
export async function kioskQueueView(ctx: StaffAppContext, req: Request) {
  const device = await kiosk(ctx, req);
  return kioskQueue(device.shopId);
}

/** Everything the front-desk screen draws in one call: the rotating QR, the PIN pad's team and the walk-in queue. */
export async function kioskHome(ctx: StaffAppContext, req: Request) {
  const device = await kiosk(ctx, req);
  const [qr, team, queue] = await Promise.all([kioskQr(ctx, req), kioskTeam(ctx, req), kioskQueue(device.shopId)]);
  return { shopId: device.shopId, shop: device.shop, device: device.label, qr: { url: qr.url, expiresAt: qr.expiresAt }, team: team.team, queue: can(ctx, "walkins.manage") || ctx.staff.kind === "shop" ? queue : null };
}
