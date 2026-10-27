import "server-only";
import { z } from "zod";
import { body, json, options, query, route } from "@/server/api";
import { can, canAny } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { loadNotificationPrefs, saveNotificationPrefs } from "@/server/staff-settings";
import { clockState } from "@/server/time-clock";
import { refreshStaffTokens, requestWhere, staffCodeLogin, staffLogout, staffPasswordLogin } from "./auth";
import { appPunch, clockOverview, kioskPunch, kioskQr, kioskStatus, kioskTeam, registerKiosk, setMyPin } from "./clock";
import { listStaffDevices, registerStaffDevice, revokeStaffDevice, updateStaffDevice } from "./devices";
import { StaffAppContext, staffRoute } from "./http";
import { bankingView, dashboardLink, earningsRange, myEarnings, myPayouts, myTipsView, onboardingLink, setMyPayoutMethod } from "./money";
import { markPopupsSeen, popupsFor } from "./popups";
import { addAppointmentNote, appointmentNotes, dayRange, myAppointment, myAppointments, mySchedule } from "./schedule";
import * as S from "./schemas";

/**
 * The staff app's API, /api/staff/v1. Each route file under src/app/api/staff/v1 re-exports one of
 * these. Every handler but sign-in runs as the Bearer token's staff member, with the permission it
 * needs checked on the server (staffRoute) and the record-level rules inside the server code it calls.
 */

export const OPTIONS = options;

// ───────────────────────────── Sign-in ─────────────────────────────

/** POST /auth/login: tokens, or { twoFactor: { ticket, enroll? } } for the code step. */
export const postLogin = route(async (req) => {
  const v = await body(req, S.LoginBody);
  return json(await staffPasswordLogin(v, requestWhere(req)));
});

/** POST /auth/login/code */
export const postLoginCode = route(async (req) => {
  const v = await body(req, S.LoginCodeBody);
  return json({ tokens: await staffCodeLogin(v, requestWhere(req)) });
});

/** POST /auth/refresh */
export const postRefresh = route(async (req) => {
  const v = await body(req, S.RefreshBody);
  return json({ tokens: await refreshStaffTokens(v.refreshToken) });
});

/** POST /auth/logout: ends the session and stops its phone's pushes. */
export const postLogout = route(async (req) => {
  const v = await body(req, S.RefreshBody);
  await staffLogout(v.refreshToken);
  return new Response(null, { status: 204 });
});

// ───────────────────────────── Me ─────────────────────────────

function features(ctx: StaffAppContext) {
  const person = ctx.staff.kind === "person";
  return {
    schedule: person,
    clientNotes: can(ctx, "notes.view"),
    clock: person && can(ctx, "timeclock.punch"),
    kiosk: can(ctx, "timeclock.kiosk"),
    kioskRegister: can(ctx, "settings.shop"),
    tips: person && can(ctx, "tips.own"),
    banking: person && can(ctx, "tips.own"),
    earnings: person && canAny(ctx, ["tips.own", "compensation.own", "report.my_sales.view"]),
    timesheet: person && can(ctx, "timesheet.own"),
    seeEveryCalendar: canAny(ctx, ["calendar.view_all", "calendar.manage"]),
  };
}

/** GET /me: who they are, their shops, what this app may show them, and every permission they hold. */
export const getMe = staffRoute({ perms: null }, async (_req, ctx) => {
  return json({
    staff: { id: ctx.staff.id, firstName: ctx.staff.firstName, displayLabel: ctx.staff.displayLabel, kind: ctx.staff.kind, role: { id: ctx.staff.roleId, key: ctx.staff.roleKey, name: ctx.staff.roleName } },
    shops: ctx.assignedShops.filter((s) => ctx.shopIds.includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
    currentShopId: ctx.currentShopId,
    combinedView: ctx.combinedView,
    features: features(ctx),
    permissions: [...ctx.permissions].sort(),
  });
});

/** GET /me/notifications: how they hear about their clients' bookings, changes, cancellations and arrivals. */
export const getNotificationPrefs = staffRoute({ perms: null, person: true }, async (_req, ctx) => {
  return json({ prefs: await loadNotificationPrefs(ctx.staff.id), devices: await listStaffDevices(ctx.staff.id) });
});

/** PUT /me/notifications */
export const putNotificationPrefs = staffRoute({ perms: null, person: true }, async (req, ctx) => {
  const prefs = await body(req, S.NotificationPrefsBody);
  return json({ prefs: await saveNotificationPrefs({ actor: ctx.actor, staffId: ctx.staff.id, shopIds: ctx.shopIds, brandWide: ctx.brandWide, canManage: false }, { staffId: ctx.staff.id, prefs }) });
});

// ───────────────────────────── Schedule and appointments ─────────────────────────────

/** GET /schedule */
export const getSchedule = staffRoute({ perms: null, person: true }, async (req, ctx) => {
  const q = query(req, S.ScheduleQuery);
  const r = dayRange(q.from, q.days);
  return json(await mySchedule(ctx, r.from, r.to, q.shopId));
});

/** GET /appointments */
export const getAppointments = staffRoute({ perms: null, person: true }, async (req, ctx) => {
  const q = query(req, S.AppointmentsQuery);
  const r = dayRange(q.from, q.days);
  return json(await myAppointments(ctx, { ...r, status: q.status ?? "all", shopId: q.shopId }));
});

/** GET /appointments/{id} */
export const getAppointment = staffRoute<{ id: string }>({ perms: null }, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await myAppointment(ctx, id));
});

/** GET /appointments/{id}/notes */
export const getAppointmentNotes = staffRoute<{ id: string }>({ perms: "notes.view", message: "You can't see client notes" }, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await appointmentNotes(ctx, id));
});

/** POST /appointments/{id}/notes */
export const postAppointmentNote = staffRoute<{ id: string }>({ perms: "notes.view", message: "You can't see client notes" }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await addAppointmentNote(ctx, id, await body(req, z.unknown())), 201);
});

// ───────────────────────────── Time clock and breaks ─────────────────────────────

const CLOCK = { perms: "timeclock.punch", person: true, message: "You can't use the time clock" } as const;

/** GET /clock */
export const getClock = staffRoute(CLOCK, async (_req, ctx) => json(await clockOverview(ctx)));

/** POST /clock/punch: in or out. */
export const postPunch = staffRoute(CLOCK, async (req, ctx) => {
  const v = await body(req, S.PunchBody);
  return json(await appPunch(ctx, req, v));
});

async function shiftShop(ctx: StaffAppContext, shopId: string | undefined) {
  if (shopId) return shopId;
  const s = await clockState(ctx.staff.id);
  if (!s.shift) throw new AppError("bad_request", "You're not clocked in.");
  return s.shift.shopId;
}

/** POST /clock/breaks/start */
export const postBreakStart = staffRoute(CLOCK, async (req, ctx) => {
  const v = await body(req, S.BreakStartBody);
  return json(await appPunch(ctx, req, { ...v, shopId: await shiftShop(ctx, v.shopId), type: "break_start" }));
});

/** POST /clock/breaks/end */
export const postBreakEnd = staffRoute(CLOCK, async (req, ctx) => {
  const v = await body(req, S.BreakEndBody);
  return json(await appPunch(ctx, req, { ...v, shopId: await shiftShop(ctx, v.shopId), type: "break_end" }));
});

/** PUT /clock/pin: their own PIN for the front-desk clock. */
export const putPin = staffRoute(CLOCK, async (req, ctx) => {
  const v = await body(req, S.PinBody);
  return json(await setMyPin(ctx, v.pin));
});

const KIOSK = { perms: "timeclock.kiosk", message: "You can't open the front-desk time clock" } as const;

/** POST /clock/kiosk/register: makes this install one of the shop's front-desk clocks. */
export const postKioskRegister = staffRoute({ perms: "settings.shop", message: "Registering a front-desk clock needs shop settings" }, async (req, ctx) => {
  const v = await body(req, S.KioskRegisterBody);
  return json(await registerKiosk(ctx, v.shopId, v.label), 201);
});

/** GET /clock/kiosk/team */
export const getKioskTeam = staffRoute(KIOSK, async (req, ctx) => json(await kioskTeam(ctx, req)));

/** GET /clock/kiosk/qr */
export const getKioskQr = staffRoute(KIOSK, async (req, ctx) => json(await kioskQr(ctx, req)));

/** POST /clock/kiosk/status */
export const postKioskStatus = staffRoute(KIOSK, async (req, ctx) => {
  const v = await body(req, S.KioskStatusBody);
  return json(await kioskStatus(ctx, req, v));
});

/** POST /clock/kiosk/punch */
export const postKioskPunch = staffRoute(KIOSK, async (req, ctx) => {
  const v = await body(req, S.KioskPunchBody);
  return json(await kioskPunch(ctx, req, v));
});

// ───────────────────────────── Tips, earnings, payouts and banking ─────────────────────────────

const TIPS = { perms: "tips.own", person: true, message: "You can't see tips" } as const;

/** GET /tips */
export const getTips = staffRoute(TIPS, async (req, ctx) => {
  const q = query(req, S.TipsQuery);
  return json(await myTipsView(ctx, q.days ?? 14));
});

/** GET /payouts */
export const getPayouts = staffRoute(TIPS, async (_req, ctx) => json(await myPayouts(ctx)));

/** GET /earnings */
export const getEarnings = staffRoute({ perms: null, person: true }, async (req, ctx) => {
  const q = query(req, S.EarningsQuery);
  const r = earningsRange(q.from, q.to);
  return json(await myEarnings(ctx, r.from, r.to));
});

/** GET /banking */
export const getBanking = staffRoute(TIPS, async (req, ctx) => {
  const q = query(req, S.BankingQuery);
  return json(await bankingView(ctx, { refresh: !!q.refresh }));
});

/** POST /banking/onboarding-link: Stripe's hosted page for their own debit card or bank account. */
export const postOnboardingLink = staffRoute(TIPS, async (_req, ctx) => json(await onboardingLink(ctx)));

/** POST /banking/dashboard-link: Stripe's page for changing that card or bank. */
export const postDashboardLink = staffRoute(TIPS, async (_req, ctx) => json(await dashboardLink(ctx)));

/** PUT /banking/method */
export const putPayoutMethod = staffRoute(TIPS, async (req, ctx) => {
  const v = await body(req, S.PayoutMethodBody);
  return json(await setMyPayoutMethod(ctx, v));
});

// ───────────────────────────── Pop-ups and push ─────────────────────────────

/** GET /popups */
export const getPopups = staffRoute({ perms: null }, async (_req, ctx) => json(await popupsFor(ctx)));

/** POST /popups/seen */
export const postPopupsSeen = staffRoute({ perms: null, person: true }, async (req, ctx) => {
  const v = await body(req, S.SeenBody);
  return json(await markPopupsSeen(ctx, v.ids));
});

/** GET /devices */
export const getDevices = staffRoute({ perms: null, person: true }, async (_req, ctx) => json({ devices: await listStaffDevices(ctx.staff.id) }));

/** POST /devices: this phone's push token, for their own clients' new, changed and cancelled bookings. */
export const postDevice = staffRoute({ perms: null, person: true }, async (req, ctx) => {
  const v = await body(req, S.DeviceBody);
  return json(await registerStaffDevice(ctx, v), 201);
});

/** PATCH /devices/{id} */
export const patchDevice = staffRoute<{ id: string }>({ perms: null, person: true }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await updateStaffDevice(ctx.staff.id, id, await body(req, S.DevicePatch)));
});

/** DELETE /devices/{id} */
export const deleteDevice = staffRoute<{ id: string }>({ perms: null, person: true }, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  await revokeStaffDevice(ctx.staff.id, id);
  return new Response(null, { status: 204 });
});
