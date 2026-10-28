/**
 * The Ray'z Staff app's contract (the mobile repo's packages/mock-api, PR #7) against core's
 * /api/staff/v1 and a real database: the app's route names answer with the fields its types read,
 * from the same server code and rules as the routes beside them. The employee is always the one
 * signed in; amounts are integer cents; My Earnings is gross only, private no-store, and every
 * view is in the audit log; a range that cuts a workweek can't be exported; clock-in takes the
 * kiosk's single-use scanned code and never anything biometric; and the front-desk kiosk is paired by a
 * manager, punches by PIN with its own credential, and is audited.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
let today = "";
let coralvilleClock: Record<string, unknown> = {};

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const S = () => m.schema;
const call = (...a: Parameters<typeof api.call>) => api.call(...a);
const login = (email: string) => api.login(email);
const withEnv = (k: string, v: string) => {
  const before = process.env[k];
  process.env[k] = v;
  onTestFinished(() => {
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  });
};
const cents = (v: unknown) => v === null || (typeof v === "number" && Number.isInteger(v));
const views = async (staffId: string) =>
  (await m.db.db.select().from(S().auditLog).where(and(eq(S().auditLog.action, "staff.earnings_view"), eq(S().auditLog.entityId, staffId)))).map((r) => (r.details as { endpoint: string }).endpoint);
const offTheClock = (staffId: string) =>
  m.db.db
    .update(S().timePunches)
    .set({ voidedAt: new Date() })
    .where(and(eq(S().timePunches.staffId, staffId), m.drizzle.isNull(S().timePunches.voidedAt), m.drizzle.gte(S().timePunches.at, m.time.startOfLocalDay(m.time.addDays(today, -1)))));

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  for (const k of ["michelle", "makenna", "kat"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(S().shops)) shop[s.slug] = s.id;
  today = m.time.todayLocal();
  coralvilleClock = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.id, shop.coralville) }))!.timeClock as Record<string, unknown>;
}, 240_000);

beforeEach(async () => {
  await m.db.db.delete(S().apiRateEvents);
});

afterAll(async () => {
  if (!m) return;
  await m.db.db.update(S().shops).set({ timeClock: coralvilleClock }).where(eq(S().shops.id, shop.coralville));
  await m.db.closeDb();
});

describe("GET /config and signing in", () => {
  it("has the app's StaffConfig fields and each shop's gates, before sign-in", async () => {
    const r = await call("GET", "config");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ appName: "Ray'z Staff", weekStartDay: 0, timezone: "America/Chicago", timeFormat: "12h", tipTransfersDefault: expect.any(Boolean) });
    expect(r.json.minSupportedVersion).toEqual({ ios: expect.any(String), android: expect.any(String) });
    const cv = r.json.shops.find((s: { slug: string }) => s.slug === "coralville");
    expect(cv).toMatchObject({ id: shop.coralville, shopId: shop.coralville, launched: expect.any(Boolean), booking: expect.stringMatching(/^(native|external|closed)$/), payments: expect.any(Boolean), clockIn: expect.any(Boolean), tipTransfers: expect.any(Boolean) });
    expect(Object.keys(cv).sort()).toEqual(["booking", "clockIn", "closedCopy", "externalBookingUrl", "id", "launchAt", "launched", "payments", "shopId", "slug", "tipTransfers"]);
  });

  it("otp/start masks where the code went; otp/verify answers the tokens flat with who signed in", async () => {
    withEnv("AUTH_DEV_CODES", "true");
    const start = await call("POST", "auth/otp/start", { body: { email: "makenna@rayz.test" } });
    expect(start.status, start.text).toBe(200);
    expect(start.json.destination).toBe("m•••@rayz.test");
    expect((await call("POST", "auth/otp/start", { body: { phone: "+13195550188" } })).json.destination).toBe("•••-•••-0188");
    const ok = await call("POST", "auth/otp/verify", { body: { email: "makenna@rayz.test", code: start.json.devCode, deviceName: "Makenna's phone" } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), tokenType: "Bearer", expiresIn: expect.any(Number), staff: { id: ids.makenna, firstName: "Makenna" } });
    expect(ok.json.staff.shops).toContain(shop.coralville);
    const me = await call("GET", "me", { token: ok.json.accessToken });
    expect(me.json).toMatchObject({ id: ids.makenna, firstName: "Makenna" });
    expect(me.json.shopIds).toEqual(ok.json.staff.shops);
  });

  it("step-up reads pin as the authenticator code; a password never counts as MFA", async () => {
    const t = await login("makenna@rayz.test");
    const off = await call("POST", "auth/step-up", { token: t.accessToken, body: { pin: "123456" } });
    expect(off.status, off.text).toBe(200);
    expect(off.json).toMatchObject({ stepUpToken: expect.any(String), expiresIn: 900, required: false });

    withEnv("ENFORCE_STAFF_MFA", "1");
    const blocked = await call("GET", "me/earnings?period=current", { token: t.accessToken });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.details).toMatchObject({ reason: "step_up_required" });
    expect((await call("POST", "auth/step-up", { token: t.accessToken, body: { pin: "000000" } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("GET", "me/earnings?period=current", { token: t.accessToken })).status).toBe(403);
  });
});

describe("My Earnings under the app's names", () => {
  it("pay-periods, earnings by period or from/to, days, tickets and payouts: their own, cents, no-store, audited", async () => {
    const t = await login("makenna@rayz.test");
    const pp = await call("GET", "me/pay-periods", { token: t.accessToken });
    expect(pp.status, pp.text).toBe(200);
    const cur = pp.json.periods.find((p: { current?: boolean }) => p.current) ?? pp.json.periods[0];
    const before = (await views(ids.makenna)).length;

    const byPeriod = await call("GET", `me/earnings?period=${cur.id}`, { token: t.accessToken });
    expect(byPeriod.status, byPeriod.text).toBe(200);
    expect(byPeriod.headers.get("cache-control")).toContain("no-store");
    const byRange = await call("GET", `me/earnings?from=${byPeriod.json.from}&to=${byPeriod.json.to}`, { token: t.accessToken });
    expect(byRange.json.totalCents).toBe(byPeriod.json.totalCents);
    for (const k of ["hourlyPayCents", "serviceCommissionCents", "greaterOfCents", "cardTipsCents", "cashTipsCents", "totalCents"]) expect(cents(byPeriod.json[k]), k).toBe(true);
    expect(JSON.stringify(byPeriod.json)).not.toMatch(/"(netPay|net|withholding|federalTax|stateTax)\w*"/i);

    const days = await call("GET", `me/earnings/days?period=${cur.id}`, { token: t.accessToken });
    expect(days.status, days.text).toBe(200);
    const tickets = await call("GET", `me/earnings/tickets?period=${cur.id}`, { token: t.accessToken });
    expect(tickets.status, tickets.text).toBe(200);
    for (const tk of tickets.json.tickets) {
      expect(tk).toHaveProperty("transfer");
      expect(tk).toHaveProperty("payout");
      if (tk.transfer) expect(Object.keys(tk.transfer).sort()).toEqual(["amountCents", "arrivalDate", "status"]);
      if (tk.payout) expect(Object.keys(tk.payout).sort()).toEqual(["amountCents", "arrivalDate", "bankLast4", "failureMessage", "status"]);
    }
    const oneDay = await call("GET", `me/earnings/tickets?from=${byPeriod.json.from}&to=${byPeriod.json.to}&date=${byPeriod.json.from}`, { token: t.accessToken });
    expect(oneDay.status, oneDay.text).toBe(200);
    expect((await call("GET", `me/earnings/tickets?period=${cur.id}&periodId=${cur.id}`, { token: t.accessToken })).status).toBe(400);
    const payouts = await call("GET", `me/payouts?period=${cur.id}`, { token: t.accessToken });
    expect(payouts.status, payouts.text).toBe(200);
    for (const p of payouts.json.payouts) expect(p).toHaveProperty("status");
    for (const x of payouts.json.transfers) expect(x).toHaveProperty("status");

    expect((await call("GET", `me/earnings?period=${cur.id}&staffId=${ids.kat}`, { token: t.accessToken })).status).toBe(400);
    const logged = (await views(ids.makenna)).slice(before);
    for (const e of ["me/earnings", "me/earnings/days", "me/earnings/tickets", "me/payouts"]) expect(logged, e).toContain(e);
  });

  it("the report: a pay period or whole workweeks as CSV or PDF, gross only, audited; a range cutting a workweek is refused", async () => {
    const t = await login("makenna@rayz.test");
    const before = (await views(ids.makenna)).length;
    const csv = await call("GET", "me/earnings/report?period=current", { token: t.accessToken });
    expect(csv.status, csv.text).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="earnings-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(csv.headers.get("cache-control")).toContain("no-store");
    const [label, header, row] = csv.text.trim().split("\n");
    expect(label).toMatch(/gross/i);
    expect(header).toBe(
      "period_start,period_end,payroll_status,production_hours,training_hours,training_pay_cents,hourly_pay_cents,service_commission_cents,product_commission_cents,top_up_cents,greater_of_cents,ot_estimated_cents,card_tips_cents,cash_tips_cents,gross_total_cents",
    );
    expect(row.split(",")).toHaveLength(15);
    expect(csv.text).not.toMatch(/net|withh/i);

    const sunday = m.time.addDays(today, -new Date(`${today}T12:00:00Z`).getUTCDay() - 7);
    const week = await call("GET", `me/earnings/report?from=${sunday}&to=${m.time.addDays(sunday, 6)}&format=pdf`, { token: t.accessToken });
    expect(week.status, week.text).toBe(200);
    expect(week.headers.get("content-type")).toBe("application/pdf");
    expect(week.text.startsWith("%PDF")).toBe(true);
    const cut = await call("GET", `me/earnings/report?from=${m.time.addDays(sunday, 1)}&to=${m.time.addDays(sunday, 6)}`, { token: t.accessToken });
    expect(cut.status).toBe(400);
    expect(cut.json.error.message).toBe("Export a whole workweek.");
    expect((await call("GET", `me/earnings/report?period=current&staffId=${ids.kat}`, { token: t.accessToken })).status).toBe(400);
    expect((await views(ids.makenna)).slice(before).filter((e) => e === "me/earnings/report")).toHaveLength(2);
  });
});

describe("cash tips, push and the payout account", () => {
  it("cash-tips is a declaration as the app's adjustment; devices registers the phone", async () => {
    const t = await login("makenna@rayz.test");
    const r = await call("POST", "me/cash-tips", { token: t.accessToken, body: { shopId: shop.coralville, amountCents: 1800, originalDate: today, attestation: true } });
    expect(r.status, r.text).toBe(201);
    expect(r.json.adjustment).toMatchObject({ kind: "declaration", shopId: shop.coralville, amountCents: 1800, originalDate: today, lateDeclaration: false, reducesPay: false });
    const [d] = await m.db.db.select().from(S().tipDeclarations).where(eq(S().tipDeclarations.id, r.json.adjustment.id));
    expect(d).toMatchObject({ staffId: ids.makenna, source: "staff_app" });
    expect((await call("POST", "me/cash-tips", { token: t.accessToken, body: { shopId: shop.moline, amountCents: 100, originalDate: today, attestation: true } })).status).toBe(403);
    const dev = await call("POST", "me/devices", { token: t.accessToken, headers: { "x-client": "android" }, body: { token: "ExponentPushToken[contract-test-0001]", reminders: true } });
    expect(dev.status, dev.text).toBe(201);
  });

  it("payout-account, its session, instant quote and preferences; cashing out on demand is 409", async () => {
    const t = await login("makenna@rayz.test");
    const a = await call("GET", "me/payout-account", { token: t.accessToken });
    expect(a.status, a.text).toBe(200);
    expect(a.headers.get("cache-control")).toContain("no-store");
    expect(a.json.account.state).toMatch(/^(not_started|in_progress|pending_verification|requirements_due|restricted|active|rejected)$/);
    expect(a.json.account).toMatchObject({ collection: "embedded", currentlyDue: expect.any(Array), pastDue: expect.any(Array), instantOptIn: expect.any(Boolean) });
    expect(JSON.stringify(a.json)).not.toMatch(/routing|account_number|"acct_/);
    const s = await call("POST", "me/payout-account/session", { token: t.accessToken });
    expect(s.status, s.text).toBe(200);
    expect(s.json).toMatchObject({ collection: "embedded" });
    expect(s.json).toHaveProperty("clientSecret");
    const done = await call("POST", "me/payout-account/session/complete", { token: t.accessToken, body: { state: "active" } });
    expect(done.status, done.text).toBe(200);
    expect(done.json.state).toBe(done.json.account.state);
    const q = await call("POST", "me/instant-payouts/quote", { token: t.accessToken, body: { amountCents: 10_000 } });
    expect(q.status, q.text).toBe(200);
    expect(q.json).toMatchObject({ amountCents: 10_000, feePaidBy: expect.stringMatching(/^(employee|shop)$/) });
    expect(cents(q.json.feeCents) && q.json.feeCents >= 50).toBe(true);
    const now = await call("POST", "me/instant-payouts", { token: t.accessToken, body: { amountCents: 10_000 } });
    expect(now.status).toBe(409);
    expect(now.json.error.details).toMatchObject({ reason: "on_demand_off" });
    const off = await call("PATCH", "me/payout-preferences", { token: t.accessToken, body: { instantOptIn: false } });
    expect(off.status, off.text).toBe(200);
    expect(off.json).toEqual({ instantOptIn: false });
  });
});

describe("the clock and the front-desk kiosk", () => {
  it("a manager pairs a kiosk; it shows the roster and QR with its own credential; a scan clocks in; PIN punches lock and a manager unlocks; revoked, it stops; all audited", async () => {
    await m.db.db
      .update(S().shops)
      .set({ timeClock: { ...coralvilleClock, methods: ["qr", "nfc"] } })
      .where(eq(S().shops.id, shop.coralville));
    await offTheClock(ids.makenna);
    const mgr = await login("michelle@rayz.test");
    const barber = await login("makenna@rayz.test");

    expect((await call("POST", "kiosk/pair", { token: barber.accessToken, body: { shopId: shop.coralville } })).status).toBe(403);
    const req = await call("POST", "kiosk/pair", { token: mgr.accessToken, body: { shopId: shop.coralville, label: "Contract desk" } });
    expect(req.status, req.text).toBe(201);
    expect(req.json).toMatchObject({ requestId: expect.any(String), shopId: shop.coralville, status: "pending", code: expect.any(String) });
    const ok = await call("POST", `kiosk/pair/${req.json.requestId}/approve`, { token: mgr.accessToken, body: {} });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json).toMatchObject({ kioskId: expect.any(String), credential: expect.any(String), shopId: shop.coralville });
    expect((await call("POST", `kiosk/pair/${req.json.requestId}/approve`, { token: mgr.accessToken, body: {} })).status).toBe(409);
    const kiosk = ok.json.credential as string;

    const roster = await call("GET", "kiosk/roster", { token: kiosk });
    expect(roster.status, roster.text).toBe(200);
    expect(roster.json.staff.find((s: { id: string }) => s.id === ids.makenna)).toEqual({ id: ids.makenna, firstName: "Makenna", photoUrl: null });
    expect(JSON.stringify(roster.json)).not.toMatch(/lastName|email|phone/);
    expect((await call("GET", "kiosk/roster", { token: barber.accessToken })).status).toBe(403);
    expect((await call("GET", "kiosk/roster", { token: "not-a-kiosk-credential" })).status).toBe(401);

    const qr = await call("GET", "kiosk/qr", { token: kiosk });
    expect(qr.status, qr.text).toBe(200);
    expect(qr.json).toMatchObject({ shopId: shop.coralville, kioskId: ok.json.kioskId, rotatesSeconds: 15 });
    expect(qr.json.token).toContain(`shop=${shop.coralville}`);
    expect((await call("GET", `kiosk/qr?shopId=${shop.moline}`, { token: kiosk })).status).toBe(404);

    expect((await call("POST", "clock/in", { token: barber.accessToken, body: { token: qr.json.token, biometric: { faceId: true } } })).status).toBe(400);
    expect((await call("POST", "clock/in", { token: barber.accessToken, body: { token: "https://x.invalid/admin/clock?shop=nope" } })).status).toBe(400);
    const inn = await call("POST", "clock/in", { token: barber.accessToken, body: { token: qr.json.token, confirmTimeOff: true } });
    expect(inn.status, inn.text).toBe(200);
    expect(inn.json.punch).toMatchObject({ staffId: ids.makenna, shopId: shop.coralville, inAt: expect.any(String), outAt: null, cashTipCents: null, attestation: false });
    const qr2 = await call("GET", "kiosk/qr", { token: kiosk });
    expect((await call("POST", "clock/out", { token: barber.accessToken, body: { token: qr2.json.token, cashTipCents: 2000 } })).status).toBe(400);
    const out = await call("POST", "clock/out", { token: barber.accessToken, body: { token: qr2.json.token, cashTipCents: 2000, attestation: true } });
    expect(out.status, out.text).toBe(200);
    expect(out.json.punch).toMatchObject({ id: inn.json.punch.id, inAt: inn.json.punch.inAt, outAt: expect.any(String) });

    expect((await call("PUT", "clock/pin", { token: barber.accessToken, body: { pin: "4826" } })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await call("POST", "kiosk/pin", { token: kiosk, body: { staffId: ids.makenna, pin: "9999" } })).status).toBe(400);
    expect((await call("POST", "kiosk/pin", { token: kiosk, body: { staffId: ids.makenna, pin: "9999" } })).status).toBe(400);
    expect((await call("POST", "kiosk/pin", { token: kiosk, body: { staffId: ids.makenna, pin: "4826" } })).status).toBe(409);
    expect((await call("POST", "kiosk/pin/unlock", { token: barber.accessToken, body: { staffId: ids.makenna, kioskId: ok.json.kioskId } })).status).toBe(403);
    const unlock = await call("POST", "kiosk/pin/unlock", { token: mgr.accessToken, body: { staffId: ids.makenna, kioskId: ok.json.kioskId } });
    expect(unlock.status, unlock.text).toBe(200);
    const pin = await call("POST", "kiosk/pin", { token: kiosk, body: { staffId: ids.makenna, pin: "4826", cashTipCents: 500 } });
    expect(pin.status, pin.text).toBe(200);
    expect(pin.json.punch).toMatchObject({ staffId: ids.makenna, shopId: shop.coralville, outAt: null });
    expect(pin.json.cashTips.error).toMatch(/phone/);

    const revoked = await call("POST", `kiosk/${ok.json.kioskId}/revoke`, { token: mgr.accessToken });
    expect(revoked.json).toEqual({ kioskId: ok.json.kioskId, revoked: true });
    expect((await call("GET", "kiosk/roster", { token: kiosk })).status).toBe(401);

    const audit = await call("GET", `audit?shopId=${shop.coralville}`, { token: mgr.accessToken });
    expect(audit.status, audit.text).toBe(200);
    const actions = audit.json.entries.map((e: { action: string }) => e.action);
    for (const a of ["timeclock.pairing_start", "kiosk.approve", "timeclock.device_revoke", "timeclock.pin_unlock"]) expect(actions, a).toContain(a);
    expect((await call("GET", "audit", { token: barber.accessToken })).status).toBe(403);
  });
});

describe("calendar and appointment status", () => {
  it("me/calendar has shopId and the app's appointments; status moves it and comes back as appointment", async () => {
    const t = await login("makenna@rayz.test");
    const svc = (await m.catalog.shopCatalog(shop.coralville)).find((s) => s.kind === "service")!;
    const [c] = await m.db.db.insert(S().customers).values({ firstName: "Odessa", lastName: "Contractwood", homeShopId: shop.coralville }).returning();
    const startsAt = m.time.zonedWallTime(today, 18 * 60 + 15).toJSDate();
    const [a] = await m.db.db
      .insert(S().appointments)
      .values({ code: `A${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`, shopId: shop.coralville, staffId: ids.makenna, customerId: c.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: "booked", source: "staff", estimateCents: 3500 })
      .returning();
    await m.db.db.insert(S().appointmentItems).values({ appointmentId: a.id, kind: "service", serviceId: svc.id, name: svc.name, priceCents: 3500, durationMin: 30 });
    const cal = await call("GET", `me/calendar?shopId=${shop.coralville}&date=${today}`, { token: t.accessToken });
    expect(cal.status, cal.text).toBe(200);
    expect(cal.json.shopId).toBe(shop.coralville);
    expect(cal.json.appointments.find((x: { id: string }) => x.id === a.id)).toEqual({ id: a.id, startsAt: startsAt.toISOString(), clientId: c.id, clientFirstName: "Odessa", serviceName: svc.name, status: "booked" });
    expect(cal.text).not.toContain("Contractwood");
    expect((await call("POST", `appointments/${a.id}/status`, { token: t.accessToken, body: { status: "confirmed", action: "confirm" } })).status).toBe(400);
    const moved = await call("POST", `appointments/${a.id}/status`, { token: t.accessToken, body: { status: "confirmed" } });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.json.appointment).toMatchObject({ id: a.id, status: "confirmed" });
  });
});
