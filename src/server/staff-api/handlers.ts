import "server-only";
import { z } from "zod";
import { body, json, options, query, route } from "@/server/api";
import { addDays, todayLocal } from "@/lib/time";
import { assertShopAccess, can, canAny } from "@/server/auth/staff";
import { stepUp } from "@/server/auth/sign-in-guard";
import { loadDisplay } from "@/server/display";
import { AppError } from "@/server/errors";
import { answerPayoutCutover, myPayoutCutover } from "@/server/payout-cutover";
import { answerPayQuestion, askPayQuestion, escalatePayQuestion, myPayQuestions, resolvePayQuestion, teamPayQuestions } from "@/server/pay-questions";
import { loadNotificationPrefs, saveNotificationPrefs } from "@/server/staff-settings";
import { requireInTenant } from "@/server/tenant";
import { clockState } from "@/server/time-clock";
import { declareCashTips, myDeclarations } from "@/server/tips/declarations";
import { assertStripePayouts } from "@/server/tips/payout-model";
import { appDeviceStatus, recordStaffAppWipe, refreshStaffTokens, requestAppDevice, requestWhere, staffAppSession, staffCodeLogin, staffLogout, staffPasswordLogin } from "./auth";
import { block, book, move, myCalendar, openings, runningLate, seesEveryColumn, setStatus, unblock } from "./calendar";
import { clientCard, contactForApp, findClientsFor, revealForApp } from "./clients";
import { KioskCaller, appPunch, clockOverview, kioskHome, kioskPunch, kioskQr, kioskQueueView, kioskStatus, kioskTeam, pairKiosk, pairedKiosk, registerKiosk, setMyPin, signedInKiosk } from "./clock";
import { assertClockOn, staffAppConfig, staffSwitches } from "./config";
import { listStaffDevices, registerStaffDevice, revokeStaffDevice, updateStaffDevice } from "./devices";
import {
  addWalkIn,
  askForTimeOff,
  decideTeamTimeOff,
  managerBoard,
  myMilestones,
  myTimeOff,
  notifyEntry,
  saleForAppointment,
  seatEntry,
  setEntryStatus,
  shopWaitlist,
  teamTimeOff,
  terminalConnectionToken,
  withdrawTimeOff,
} from "./front";
import { StaffAppContext, guardedStaff, shopOf, signInRoute, staffRoute, withCacheRule } from "./http";
import { accountSession, bankingView, dashboardLink, earningsRange, myEarnings, myExternalAccounts, myPayouts, myTipsView, onboardingLink, setMyDepositConsent, setMyPayoutMethod } from "./money";
import { myEarningsTips, myTipTransfers } from "./earnings-detail";
import { myPeriodEarnings, myYearToDate, payoutSetup } from "./pay";
import { markPopupsSeen, popupsFor } from "./popups";
import { addAppointmentNote, appointmentNotes, dayRange, myAppointment, myAppointments, mySchedule } from "./schedule";
import * as S from "./schemas";
import { acceptAppInvite, appInviteView, endMyOtherSessions, endMyStaffAppSession, listStaffAppSessions, sendStaffAppInvite, signOutOfStaffApp, startStaffCode, verifyStaffCode } from "./sign-in";
import { addTeamPunch, approveTimecard, editTeamPunch, managesTimecards, myTimecard, signOffMine, teamTimecard, teamTimecards, timecardExport, voidTeamPunch } from "./timecard";

/**
 * The staff app's API, /api/staff/v1. Each route file under src/app/api/staff/v1 re-exports one of
 * these. Every handler but sign-in runs as the Bearer token's staff member, with the permission it
 * needs checked on the server (staffRoute) and the record-level rules inside the server code it calls.
 */

export const OPTIONS = options;

// ───────────────────────────── Sign-in ─────────────────────────────

/** POST /auth/login: tokens, or { twoFactor: { ticket, enroll? } } for the code step. */
export const postLogin = signInRoute(async (req) => {
  const v = await body(req, S.LoginBody);
  return json(await staffPasswordLogin(v, requestWhere(req)));
});

/** POST /auth/login/code */
export const postLoginCode = signInRoute(async (req) => {
  const v = await body(req, S.LoginCodeBody);
  return json({ tokens: await staffCodeLogin(v, requestWhere(req)) });
});

/** POST /auth/code/start: a sign-in code by text (Twilio Verify where set up) or email. The same answer whether or not they're on file. */
export const postCodeStart = signInRoute(async (req) => {
  const v = await body(req, S.CodeStartBody);
  return json(await startStaffCode(v, requestWhere(req)));
});

/** POST /auth/code/verify: tokens, or the authenticator step for two-step sign-in. */
export const postCodeVerify = signInRoute(async (req) => {
  const v = await body(req, S.CodeVerifyBody);
  return json(await verifyStaffCode(v, requestWhere(req)));
});

/** GET /auth/invite?token=: the invite screen. */
export const getInvite = signInRoute(async (req) => {
  const q = query(req, S.InviteQuery);
  return json(await appInviteView(q.token));
});

/** POST /auth/invite/accept */
export const postInviteAccept = signInRoute(async (req) => {
  const v = await body(req, S.InviteAcceptBody);
  return json(await acceptAppInvite(v, requestWhere(req)));
});

/** POST /auth/refresh: a refresh token bound to an install works only with that install's deviceId. */
export const postRefresh = signInRoute(async (req) => {
  const v = await body(req, S.RefreshBody);
  return json({ tokens: await refreshStaffTokens(v.refreshToken, v.deviceId) });
});

/** POST /auth/logout: ends the session and stops its phone's pushes. */
export const postLogout = signInRoute(async (req) => {
  const v = await body(req, S.LogoutBody);
  await staffLogout(v.refreshToken);
  return new Response(null, { status: 204 });
});

/** POST /auth/wiped: the phone deleted its data after a refused session (ST-I18). */
export const postWiped = signInRoute(async (req) => {
  const v = await body(req, S.WipedBody);
  await recordStaffAppWipe(v.refreshToken, v.wipe, requestWhere(req));
  return new Response(null, { status: 204 });
});

/** POST /auth/device/request: ask for this install to be approved at a location that takes approved devices. */
export const postDeviceRequest = signInRoute(async (req) => {
  const v = await body(req, S.DeviceRequestBody);
  return json(await requestAppDevice(v, requestWhere(req), v.ticket ? null : await staffAppSession(req)));
});

/** GET /auth/device: this install's approvals. */
export const getDeviceStatus = signInRoute(async (req) => json(await appDeviceStatus(requestWhere(req))));

/** GET /config: minimum versions, switches and links, read at launch before sign-in. Not version-gated. */
export const getConfig = route(async (req) => {
  await loadDisplay();
  return withCacheRule(req, json(staffAppConfig(req)));
});

// ───────────────────────────── Me ─────────────────────────────

function features(ctx: StaffAppContext) {
  const person = ctx.staff.kind === "person";
  const on = staffSwitches();
  return {
    schedule: person,
    calendar: person || seesEveryColumn(ctx),
    clientNotes: can(ctx, "notes.view"),
    clients: true,
    clock: on.clock && person && can(ctx, "timeclock.punch"),
    kiosk: can(ctx, "timeclock.kiosk"),
    kioskRegister: can(ctx, "settings.shop"),
    tips: person && can(ctx, "tips.own"),
    payouts: person && can(ctx, "tips.own"),
    banking: on.stripePayouts && person && can(ctx, "tips.own"),
    earnings: person && canAny(ctx, ["tips.own", "compensation.own", "report.my_sales.view", "timesheet.own"]),
    timesheet: person && can(ctx, "timesheet.own"),
    timeOff: person && can(ctx, "timeoff.request"),
    milestones: person,
    waitlist: can(ctx, "walkins.manage"),
    checkout: person || can(ctx, "checkout.any"),
    tapToPay: on.tapToPay && (person || can(ctx, "checkout.any")),
    manager: canAny(ctx, MANAGER_PERMS),
    timecards: managesTimecards(ctx),
    approveTimeOff: can(ctx, "timeoff.approve"),
    manageUsers: can(ctx, "permissions.manage"),
    seeEveryCalendar: seesEveryColumn(ctx),
  };
}

const MANAGER_PERMS = ["calendar.view_all", "calendar.manage", "walkins.manage", "timeoff.approve", "timesheet.approve", "inventory.manage", "inventory.adjust", "po.create", "po.receive"] as const;

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

/** GET /me/sessions: every phone signed in as them. */
export const getSessions = staffRoute({ perms: null }, async (_req, ctx) => json({ sessions: await listStaffAppSessions(ctx.staff.id, ctx.sessionId) }));

/** DELETE /me/sessions/{id}: sign a lost phone out. */
export const deleteSession = staffRoute<{ id: string }>({ perms: null }, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  await endMyStaffAppSession(ctx.staff.id, id);
  return new Response(null, { status: 204 });
});

/** POST /me/sessions/sign-out-others */
export const postSignOutOthers = staffRoute({ perms: null }, async (_req, ctx) => json({ ended: await endMyOtherSessions(ctx.staff.id, ctx.sessionId) }));

/** POST /me/step-up: confirm it's them (password, or their authenticator code) before reveal; good for 15 minutes on this session. */
export const postStepUp = staffRoute({ perms: null }, async (req, ctx) => {
  const v = await body(req, S.StepUpBody);
  return json(await stepUp(ctx, v));
});

/** GET /me/calendar?date=&shopId=&all= */
export const getCalendar = staffRoute({ perms: null }, async (req, ctx) => {
  const q = query(req, S.CalendarQuery);
  if (ctx.staff.kind !== "person" && !seesEveryColumn(ctx)) throw new AppError("forbidden", "A shop login sees the calendar with calendar.view_all");
  return json(await myCalendar(ctx, { date: q.date, shopId: q.shopId, all: q.all === undefined ? undefined : q.all === "1" || q.all === "true" }));
});

/** GET /me/timecard?period= */
export const getMyTimecard = staffRoute({ perms: "timesheet.own", person: true, message: "You can't see your timecard" }, async (req, ctx) => {
  const q = query(req, S.PeriodQuery);
  return json(await myTimecard(ctx, q.period));
});

/** POST /me/timecard/sign-off */
export const postTimecardSignOff = staffRoute({ perms: "timesheet.own", person: true, message: "You can't sign off your timecard" }, async (req, ctx) => {
  const v = await body(req, S.SignOffBody);
  return json(await signOffMine(ctx, v));
});

const PAY = { perms: ["timesheet.own", "tips.own", "compensation.own", "report.my_sales.view"], person: true, message: "You can't see your earnings" } as const;
const TIPS = { perms: "tips.own", person: true, message: "You can't see tips" } as const;

/** GET /me/earnings?period=: one pay period, per shop, from the same payroll run as the iSolved export. */
export const getPeriodEarnings = staffRoute(PAY, async (req, ctx) => {
  const q = query(req, S.PeriodEarningsQuery);
  return json(await myPeriodEarnings(ctx, q.period));
});

/** GET /me/earnings/tips?period=: their own tips per ticket and per day, card and cash on tickets, and cash they declared. */
export const getEarningsTips = staffRoute(TIPS, async (req, ctx) => {
  const q = query(req, S.PeriodEarningsQuery);
  return json(await myEarningsTips(ctx, q.period));
});

/** GET /me/earnings/transfers?period=: each of their card tips' transfer to their Stripe account and the payout after it. */
export const getEarningsTransfers = staffRoute(TIPS, async (req, ctx) => {
  const q = query(req, S.PeriodEarningsQuery);
  return json(await myTipTransfers(ctx, q.period));
});

/** GET /me/earnings/ytd?year= */
export const getYearToDate = staffRoute(PAY, async (req, ctx) => {
  const q = query(req, S.YtdQuery);
  return json(await myYearToDate(ctx, q.year));
});

/** GET /me/payout-setup: how each shop pays their tips (payroll by default) and the payroll portal link. */
export const getPayoutSetup = staffRoute({ perms: "tips.own", person: true, message: "You can't see tips" }, async (_req, ctx) => json(await payoutSetup(ctx)));

/** GET /me/payout-cutover: what Squire still owed them at the switch, and their answer. */
export const getPayoutCutover = staffRoute({ perms: "tips.own", person: true, message: "You can't see tips" }, async (_req, ctx) => json(await myPayoutCutover(ctx.staff.id, ctx.shopIds)));

/** POST /me/payout-cutover/confirm */
export const postPayoutCutoverConfirm = staffRoute({ perms: "tips.own", person: true, message: "You can't see tips" }, async (req, ctx) => {
  const v = await body(req, S.CutoverAnswerBody);
  const shopId = shopOf(ctx, v.shopId);
  await answerPayoutCutover(ctx.actor, ctx.staff.id, shopId, v);
  return json(await myPayoutCutover(ctx.staff.id, ctx.shopIds));
});

/** GET /me/milestones */
export const getMilestones = staffRoute({ perms: null, person: true }, async (_req, ctx) => json(await myMilestones(ctx)));

/** GET /me/time-off-requests */
export const getMyTimeOff = staffRoute({ perms: null, person: true }, async (_req, ctx) => json(await myTimeOff(ctx)));

/** POST /me/time-off-requests */
export const postMyTimeOff = staffRoute({ perms: "timeoff.request", person: true, message: "You can't request time off" }, async (req, ctx) => {
  const v = await body(req, S.TimeOffBody);
  const r = await askForTimeOff(ctx, v);
  return json(r, r.saved ? 201 : 200);
});

/** DELETE /me/time-off-requests/{id} */
export const deleteMyTimeOff = staffRoute<{ id: string }>({ perms: null, person: true }, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  await withdrawTimeOff(ctx, id);
  return new Response(null, { status: 204 });
});

// ───────────────────────────── Schedule and appointments ─────────────────────────────

/** GET /schedule (and GET /me/schedule) */
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

/** POST /appointments: book from the phone. */
export const postAppointment = staffRoute({ perms: null }, async (req, ctx) => {
  const v = await body(req, S.BookBody);
  if (!v.customerId && !v.customer) throw new AppError("bad_request", "Send customerId, or customer for a new client", { field: "customerId" });
  return json(await book(ctx, { ...v, staffId: v.staffId ?? ctx.staff.id, addonIds: v.addonIds ?? [], customerId: v.customerId ?? null, customer: v.customer ?? null, notes: v.notes ?? null, squeezeIn: !!v.squeezeIn }), 201);
});

/** POST /appointments/{id}/status */
export const postAppointmentStatus = staffRoute<{ id: string }>({ perms: null }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const v = await body(req, S.StatusBody);
  return json(await setStatus(ctx, id, v.action));
});

/** POST /appointments/{id}/move */
export const postAppointmentMove = staffRoute<{ id: string }>({ perms: null }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await move(ctx, id, await body(req, S.MoveBody)));
});

/** POST /appointments/{id}/late */
export const postAppointmentLate = staffRoute<{ id: string }>({ perms: null }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const v = await body(req, S.LateBody);
  return json(await runningLate(ctx, id, v.minutes));
});

/** GET /openings */
export const getOpenings = staffRoute({ perms: null }, async (req, ctx) => {
  const q = query(req, S.OpeningsQuery);
  const addonIds = q.addonIds ? z.array(z.uuid()).max(10).parse(q.addonIds.split(",").filter(Boolean)) : [];
  return json(await openings(ctx, { ...q, addonIds }));
});

/** POST /blocks */
export const postBlock = staffRoute({ perms: ["blocks.own", "blocks.others"], message: "You can't block time" }, async (req, ctx) => {
  const v = await body(req, S.BlockBody);
  const r = await block(ctx, { ...v, note: v.note ?? null, allShops: !!v.allShops, confirm: !!v.confirm });
  return json(r, r.saved ? 201 : 200);
});

/** DELETE /blocks/{id} */
export const deleteBlock = staffRoute<{ id: string }>({ perms: ["blocks.own", "blocks.others"], message: "You can't change blocked time" }, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  await unblock(ctx, id);
  return new Response(null, { status: 204 });
});

// ───────────────────────────── Clients ─────────────────────────────

/** GET /clients?q= */
export const getClients = staffRoute({ perms: null }, async (req, ctx) => {
  const q = query(req, S.ClientSearchQuery);
  return json(await findClientsFor(ctx, q.q, q.limit));
});

/** GET /clients/{id} */
export const getClient = staffRoute<{ id: string }>({ perms: null }, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await clientCard(ctx, id));
});

/** POST /clients/{id}/reveal */
export const postClientReveal = staffRoute<{ id: string }>({ perms: "clients.reveal", message: "You can't reveal client details" }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await revealForApp(ctx, id, await body(req, S.RevealBody)));
});

/** POST /clients/{id}/contact */
export const postClientContact = staffRoute<{ id: string }>({ perms: "clients.message", message: "You can't contact clients" }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await contactForApp(ctx, id, await body(req, S.ContactBody)));
});

// ───────────────────────────── Time clock and breaks ─────────────────────────────

const CLOCK = { perms: "timeclock.punch", person: true, message: "You can't use the time clock" } as const;

/** GET /clock */
export const getClock = staffRoute(CLOCK, async (_req, ctx) => json(await clockOverview(ctx)));

/** POST /clock/punch: in or out. */
export const postPunch = staffRoute(CLOCK, async (req, ctx) => {
  assertClockOn();
  const v = await body(req, S.PunchBody);
  return json(await appPunch(ctx, req, v));
});

const punchAs = (type: "in" | "out") =>
  staffRoute(CLOCK, async (req, ctx) => {
    assertClockOn();
    const v = await body(req, S.ClockInOutBody);
    return json(await appPunch(ctx, req, { ...v, type }));
  });

/** POST /clock/in */
export const postClockIn = punchAs("in");

/** POST /clock/out */
export const postClockOut = punchAs("out");

async function shiftShop(ctx: StaffAppContext, shopId: string | undefined) {
  if (shopId) return shopId;
  const s = await clockState(ctx.staff.id);
  if (!s.shift) throw new AppError("bad_request", "You're not clocked in.");
  return s.shift.shopId;
}

/** POST /clock/breaks/start */
export const postBreakStart = staffRoute(CLOCK, async (req, ctx) => {
  assertClockOn();
  const v = await body(req, S.BreakStartBody);
  return json(await appPunch(ctx, req, { ...v, shopId: await shiftShop(ctx, v.shopId), type: "break_start" }));
});

/** POST /clock/breaks/end */
export const postBreakEnd = staffRoute(CLOCK, async (req, ctx) => {
  assertClockOn();
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

/** POST /clock/kiosk/pair: a manager's pairing code makes this install a front-desk clock, with no staff sign-in. */
export const postKioskPair = signInRoute(async (req) => {
  const v = await body(req, S.KioskPairBody);
  return json(await pairKiosk(req, v), 201);
});

/** A front-desk clock call: a paired install on its own, else a signed-in login with the clock permission on a registered device. */
const kioskRoute = (fn: (req: Request, k: KioskCaller) => Promise<Response>) =>
  signInRoute(async (req) => {
    const paired = await pairedKiosk(req);
    if (paired) return fn(req, paired);
    return fn(req, await signedInKiosk(await guardedStaff(req, KIOSK), req));
  });

/** GET /clock/kiosk/team */
export const getKioskTeam = kioskRoute(async (_req, k) => json(await kioskTeam(k)));

/** GET /clock/kiosk/qr */
export const getKioskQr = kioskRoute(async (_req, k) => json(await kioskQr(k)));

/** POST /clock/kiosk/status */
export const postKioskStatus = kioskRoute(async (req, k) => {
  const v = await body(req, S.KioskStatusBody);
  return json(await kioskStatus(k, v));
});

/** POST /clock/kiosk/punch */
export const postKioskPunch = kioskRoute(async (req, k) => {
  const v = await body(req, S.KioskPunchBody);
  return json(await kioskPunch(k, req, v));
});

/** GET /clock/kiosk: the front-desk screen in one call (QR, team, walk-in queue). */
export const getKioskHome = kioskRoute(async (_req, k) => json(await kioskHome(k)));

/** GET /clock/kiosk/queue */
export const getKioskQueue = kioskRoute(async (_req, k) => json(await kioskQueueView(k)));

// ───────────────────────────── Tips, earnings, payouts and banking ─────────────────────────────

/** GET /tips */
export const getTips = staffRoute(TIPS, async (req, ctx) => {
  const q = query(req, S.TipsQuery);
  return json(await myTipsView(ctx, q.days ?? 14));
});

/** GET /tips/declarations */
export const getTipDeclarations = staffRoute(TIPS, async (req, ctx) => {
  const q = query(req, S.DeclarationsQuery);
  return json(await myDeclarations(ctx.staff.id, q.from ?? addDays(todayLocal(), -62)));
});

/** POST /tips/declarations: cash tips they were handed (SB-C3), or a correction of one. */
export const postTipDeclaration = staffRoute(TIPS, async (req, ctx) => {
  const v = await body(req, S.DeclareBody);
  assertShopAccess(ctx, v.shopId);
  const d = await declareCashTips({ staffId: ctx.staff.id, shopId: v.shopId, businessDate: v.businessDate, amountCents: v.amountCents, attested: v.attest, replacesId: v.replacesId ?? null, reason: v.reason ?? null, source: "staff_app", actor: ctx.actor });
  return json({ id: d.id, businessDate: d.businessDate, amountCents: d.amountCents, replacesId: d.replacesId }, 201);
});

/** GET /payouts */
export const getPayouts = staffRoute(TIPS, async (_req, ctx) => json(await myPayouts(ctx)));

/** GET /earnings */
export const getEarnings = staffRoute({ perms: null, person: true }, async (req, ctx) => {
  const q = query(req, S.EarningsQuery);
  const r = earningsRange(q.from, q.to);
  return json(await myEarnings(ctx, r.from, r.to));
});

/**
 * Direct Stripe payouts to each employee (ST-I9). Where FEATURE_STAFF_STRIPE_PAYOUTS=false switches
 * them off, every /banking route is 403 with details.feature = staff_stripe_payouts, and tips go through payroll.
 */
const banking = <P = Record<string, string>>(fn: (req: Request, ctx: StaffAppContext, params: P) => Promise<Response>) =>
  staffRoute<P>(TIPS, async (req, ctx, params) => {
    assertStripePayouts();
    return fn(req, ctx, params);
  });

/** GET /banking */
export const getBanking = banking(async (req, ctx) => {
  const q = query(req, S.BankingQuery);
  return json(await bankingView(ctx, { refresh: !!q.refresh }));
});

/** GET /banking/external-accounts: their bank accounts and debit cards, last 4 only. */
export const getExternalAccounts = banking(async (req, ctx) => {
  const q = query(req, S.BankingQuery);
  return json(await myExternalAccounts(ctx, { refresh: !!q.refresh }));
});

/** POST /banking/onboarding-link: Stripe's hosted page for their own debit card or bank account. */
export const postOnboardingLink = banking(async (_req, ctx) => json(await onboardingLink(ctx)));

/** POST /banking/account-session: Stripe's embedded onboarding and account management in the app. */
export const postAccountSession = banking(async (_req, ctx) => json(await accountSession(ctx)));

/** POST /banking/dashboard-link: Stripe's page for changing that card or bank. */
export const postDashboardLink = banking(async (_req, ctx) => json(await dashboardLink(ctx)));

/** PUT /banking/method */
export const putPayoutMethod = banking(async (req, ctx) => {
  const v = await body(req, S.PayoutMethodBody);
  return json(await setMyPayoutMethod(ctx, v));
});

/** PUT /banking/deposit-consent */
export const putDepositConsent = banking(async (req, ctx) => {
  const v = await body(req, S.DepositConsentBody);
  return json(await setMyDepositConsent(ctx, v));
});

// ───────────────────────────── Manager: timecards (ST-C5, ST-I7) ─────────────────────────────

const TIMECARDS = { perms: ["timesheet.edit", "timesheet.approve", "payroll.export"], message: "You can't see the team's timecards" } as const;
const EDIT_PUNCHES = { perms: "timesheet.edit", message: "You can't edit punches" } as const;

/** GET /timecards?period=&shopId= */
export const getTimecards = staffRoute(TIMECARDS, async (req, ctx) => {
  const q = query(req, S.TeamTimecardsQuery);
  return json(await teamTimecards(ctx, q));
});

/** GET /timecards/export?period=&format=&shopId=: the CSV itself; X-Payroll-Draft: true before the period is locked. */
export const getTimecardExport = staffRoute({ perms: "payroll.export", message: "You can't export payroll" }, async (req, ctx) => {
  const q = query(req, S.ExportQuery);
  const r = await timecardExport(ctx, q);
  return new Response(r.body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.fileName}"`, "Cache-Control": "no-store", "X-Payroll-Draft": String(r.draft) },
  });
});

/** GET /timecards/{id}?period=: id is the staff member. */
export const getTimecard = staffRoute<{ id: string }>(TIMECARDS, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const q = query(req, S.PeriodQuery);
  return json(await teamTimecard(ctx, id, q.period));
});

/** POST /timecards/{id}/approve */
export const postTimecardApprove = staffRoute<{ id: string }>({ perms: "timesheet.approve", message: "You can't approve timecards" }, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await approveTimecard(ctx, id, await body(req, S.ApproveBody)));
});

/** POST /timecards/{id}/punches */
export const postTeamPunch = staffRoute<{ id: string }>(EDIT_PUNCHES, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await addTeamPunch(ctx, id, await body(req, S.AddPunchBody)), 201);
});

/** PATCH /punches/{id} */
export const patchPunch = staffRoute<{ id: string }>(EDIT_PUNCHES, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await editTeamPunch(ctx, id, await body(req, S.EditPunchBody)));
});

/** POST /punches/{id}/void */
export const postPunchVoid = staffRoute<{ id: string }>(EDIT_PUNCHES, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const v = await body(req, S.VoidPunchBody);
  await voidTeamPunch(ctx, id, v.reason);
  return new Response(null, { status: 204 });
});

// ───────────────────────────── Manager: time off (ST-I1) ─────────────────────────────

const APPROVE_OFF = { perms: "timeoff.approve", message: "You can't approve time off" } as const;

/** GET /time-off-requests?shopId=&status= */
export const getTeamTimeOff = staffRoute(APPROVE_OFF, async (req, ctx) => json(await teamTimeOff(ctx, query(req, S.TeamTimeOffQuery))));

/** POST /time-off-requests/{id}/decision */
export const postTimeOffDecision = staffRoute<{ id: string }>(APPROVE_OFF, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await decideTeamTimeOff(ctx, id, await body(req, S.DecisionBody)));
});

// ───────────────────────────── Walk-ins and the waitlist (ST-I3) ─────────────────────────────

const WALKINS = { perms: "walkins.manage", message: "You can't manage walk-ins" } as const;

/** GET /shops/{id}/waitlist */
export const getWaitlist = staffRoute<{ id: string }>(WALKINS, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await shopWaitlist(ctx, id));
});

/** POST /shops/{id}/waitlist */
export const postWaitlist = staffRoute<{ id: string }>(WALKINS, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await addWalkIn(ctx, id, await body(req, S.WalkInBody)), 201);
});

/** POST /waitlist/{id}/seat */
export const postWaitlistSeat = staffRoute<{ id: string }>(WALKINS, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const v = await body(req, S.SeatBody);
  return json(await seatEntry(ctx, id, v.staffId));
});

/** POST /waitlist/{id}/status */
export const postWaitlistStatus = staffRoute<{ id: string }>(WALKINS, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const v = await body(req, S.EntryStatusBody);
  await setEntryStatus(ctx, id, v.status);
  return new Response(null, { status: 204 });
});

/** POST /waitlist/{id}/notify */
export const postWaitlistNotify = staffRoute<{ id: string }>(WALKINS, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await notifyEntry(ctx, id));
});

// ───────────────────────────── Checkout at the chair (ST-I4) ─────────────────────────────

/** POST /sales */
export const postSale = staffRoute({ perms: null }, async (req, ctx) => json(await saleForAppointment(ctx, await body(req, S.SaleBody)), 201));

/** POST /terminal/connection-token: off until FEATURE_STAFF_TAP_TO_PAY. */
export const postTerminalToken = staffRoute({ perms: null }, async (req, ctx) => json(await terminalConnectionToken(ctx, await body(req, S.TerminalTokenBody))));

// ───────────────────────────── Manager: the board and the team's app access (ST-I7, ST-C10) ─────────────────────────────

/** GET /manager/board?shopId= */
export const getManagerBoard = staffRoute({ perms: MANAGER_PERMS, message: "You don't have a manager's view of this shop" }, async (req, ctx) => {
  const q = query(req, S.BoardQuery);
  return json(await managerBoard(ctx, q.shopId));
});

const USERS = { perms: "permissions.manage", message: "You can't manage users" } as const;

/** POST /staff/{id}/app-invite: the staff app's sign-in link by text or email. */
export const postStaffAppInvite = staffRoute<{ id: string }>(USERS, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  await requireInTenant(ctx, "staff", id);
  const v = await body(req, S.AppInviteBody);
  return json(await sendStaffAppInvite(ctx, id, v.channel ?? null));
});

/** POST /staff/{id}/sign-out: every staff app session and phone, without deactivating them. */
export const postStaffSignOut = staffRoute<{ id: string }>(USERS, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  await requireInTenant(ctx, "staff", id);
  await signOutOfStaffApp(ctx, id);
  return new Response(null, { status: 204 });
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

// ───────────────────────────── Pay questions (ST-I10) ─────────────────────────────

const OWN_PAY = { perms: "timesheet.own", person: true, message: "You can't ask about your pay here" } as const;
const ANSWER_PAY = { perms: ["timesheet.approve", "payroll.run", "payroll.export", "payroll.approve"], message: "You can't answer pay questions" } as const;
const viewer = (ctx: StaffAppContext) => ({ staffId: ctx.staff.id, actor: ctx.actor, isOwner: ctx.isOwner, shopIds: ctx.shopIds, permissions: ctx.permissions });

/** GET /me/pay-questions */
export const getMyPayQuestions = staffRoute(OWN_PAY, async (_req, ctx) => json({ questions: await myPayQuestions(ctx.staff.id) }));

/** POST /me/pay-questions */
export const postPayQuestion = staffRoute(OWN_PAY, async (req, ctx) => {
  const v = await body(req, S.PayQuestionBody);
  return json(await askPayQuestion({ staffId: ctx.staff.id, actor: ctx.actor }, v), 201);
});

/** POST /me/pay-questions/{id}/escalate */
export const postPayQuestionEscalate = staffRoute<{ id: string }>(OWN_PAY, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const v = await body(req, S.PayQuestionEscalateBody);
  return json(await escalatePayQuestion({ staffId: ctx.staff.id, actor: ctx.actor }, id, v.note ?? null));
});

/** POST /me/pay-questions/{id}/resolve */
export const postPayQuestionResolve = staffRoute<{ id: string }>(OWN_PAY, async (_req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  return json(await resolvePayQuestion({ staffId: ctx.staff.id, actor: ctx.actor }, id));
});

/** GET /pay-questions?open= */
export const getTeamPayQuestions = staffRoute(ANSWER_PAY, async (req, ctx) => {
  const q = query(req, S.TeamPayQuestionsQuery);
  return json({ questions: await teamPayQuestions(viewer(ctx), { open: q.open === "true" }) });
});

/** POST /pay-questions/{id}/answer */
export const postPayQuestionAnswer = staffRoute<{ id: string }>(ANSWER_PAY, async (req, ctx, params) => {
  const { id } = S.IdParam.parse(params);
  const v = await body(req, S.PayQuestionAnswerBody);
  return json(await answerPayQuestion(viewer(ctx), id, v.answer));
});
