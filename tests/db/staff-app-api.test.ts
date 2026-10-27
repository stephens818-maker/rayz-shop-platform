/**
 * The staff app's day on /api/staff/v1 (ST-C1 to ST-C10, ST-I1 to ST-I8, ST-I10) against a real
 * database: every handler goes through staffRoute (authorize() and assertShopAccess()) or is one of
 * the named sign-in routes; codes, invites, install-bound refresh and remote sign-out; the calendar,
 * client card, timecards, earnings that match the payroll run to the cent, payroll as the tip
 * payout path while Stripe payouts are held, the Squire payout cutover, time off, the waitlist,
 * checkout, the kiosk and the manager's board; and no client phone, email or masked value in any
 * answer a barber gets.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { STAFF_ROUTE_FILES, routePathOf, staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
let today = "";
let slot = 0;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const S = () => m.schema;
const call = (...a: Parameters<typeof api.call>) => api.call(...a);
const login = (email: string, extra?: Record<string, unknown>) => api.login(email, undefined, extra);
const setOverrides = (who: string, o: Record<string, boolean>) => m.db.db.update(S().staff).set({ permissionOverrides: o }).where(eq(S().staff.id, ids[who]));
const withEnv = (k: string, v: string) => {
  const before = process.env[k];
  process.env[k] = v;
  onTestFinished(() => {
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  });
};

const CLIENT = { first: "Odessa", last: "Privatewood", phone: "+13195558421", email: "odessa.private@example.test", address: "88 Hidden Lane" };
/** Never in anything a barber's phone receives. */
const NEVER = [CLIENT.phone, "5558421", "555-8421", CLIENT.email, CLIENT.address];

async function appt(staffId: string, o: { daysAhead?: number; status?: string; customerId?: string } = {}) {
  const startsAt = m.time.zonedWallTime(m.time.addDays(today, o.daysAhead ?? 0), 30 + 35 * slot++).toJSDate();
  const [a] = await m.db.db
    .insert(S().appointments)
    .values({
      code: `A${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: shop.coralville,
      staffId,
      customerId: o.customerId ?? ids.client,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: (o.status ?? "booked") as "booked",
      source: "staff",
      estimateCents: 3500,
    })
    .returning();
  await m.db.db.insert(S().appointmentItems).values({ appointmentId: a.id, kind: "service", serviceId: ids.service, name: "Ray'z Cut", priceCents: 3500, durationMin: 30 });
  return a;
}

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  for (const k of ["owner", "regional", "michelle", "frontdesk", "makenna", "kat", "coralville", "manager.moline"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(S().shops)) shop[s.slug] = s.id;
  today = m.time.todayLocal();
  ids.service = (await m.catalog.shopCatalog(shop.coralville)).find((s) => s.kind === "service")!.id;
  const [c] = await m.db.db
    .insert(S().customers)
    .values({ firstName: CLIENT.first, lastName: CLIENT.last, phone: CLIENT.phone, email: CLIENT.email, address: CLIENT.address, homeShopId: shop.coralville, smsOptIn: true })
    .returning();
  ids.client = c.id;
}, 240_000);

// Sign-ins here come from one address in moments; the per-network limit is tested on its own.
beforeEach(async () => {
  await m.db.db.delete(S().apiRateEvents);
});

afterAll(async () => {
  if (!m) return;
  await m.db.db.update(S().staff).set({ permissionOverrides: {} });
  await m.db.closeDb();
});

describe("every route is guarded", () => {
  const src = readFileSync(join(process.cwd(), "src/server/staff-api/handlers.ts"), "utf8");
  const exported = [...src.matchAll(/^export const (\w+)\s*=\s*([\w.]+)/gm)].map((x) => ({ name: x[1], via: x[2] }));
  /** Before sign-in: the version gate only. GET /config is read before anything else, ungated. */
  const PUBLIC = new Set(["postLogin", "postLoginCode", "postCodeStart", "postCodeVerify", "getInvite", "postInviteAccept", "postRefresh", "postLogout", "postWiped", "postDeviceRequest", "getDeviceStatus", "getConfig", "postKioskPair"]);

  it("each handler is staffRoute (authorize + assertShopAccess), a wrapper of it, or a named sign-in route", () => {
    const handlers = exported.filter((e) => e.name !== "OPTIONS");
    expect(handlers.length).toBeGreaterThan(80);
    for (const h of handlers) {
      if (PUBLIC.has(h.name)) expect(["signInRoute", "route"], h.name).toContain(h.via);
      else expect(["staffRoute", "banking", "punchAs", "kioskRoute"], h.name).toContain(h.via);
    }
    expect(src).toMatch(/const banking = [^]*?staffRoute<P>\(TIPS/);
    expect(src).toMatch(/const punchAs = [^]*?staffRoute\(CLOCK/);
    // The front-desk clock: a paired install's own token, else the same guard as staffRoute.
    expect(src).toMatch(/const kioskRoute = [^]*?pairedKiosk\(req\);\s*if \(paired\) return fn\(req, paired\);\s*return fn\(req, await signedInKiosk\(await guardedStaff\(req, KIOSK\), req\)\)/);
    const http = readFileSync(join(process.cwd(), "src/server/staff-api/http.ts"), "utf8");
    expect(http).toMatch(/assertSupportedStaffClient\(req\);\s*const \[ctx\] = await Promise\.all\(\[guardedStaff\(req, guard\), loadDisplay\(\)\]\);\s*return withCacheRule\(req, await fn\(req, ctx, params\)\)/);
    expect(http).toMatch(/const ctx = await requireStaffApp\(req\);\s*assertShopHeader\(req, ctx\);\s*authorizeContext\(ctx/);
  });

  it("route files only re-export handlers, and the spec's sign-in routes are exactly the public ones", async () => {
    for (const f of STAFF_ROUTE_FILES) {
      if (f.includes("openapi.json")) continue;
      const text = readFileSync(f, "utf8");
      expect(text, f).toMatch(/^import \{[^}]+\} from "@\/server\/staff-api\/handlers";/);
      expect(text.split("\n").filter((l) => l.startsWith("import")), f).toHaveLength(1);
    }
    const { staffOpenApiDocument } = await import("@/server/staff-api/openapi");
    const doc = staffOpenApiDocument("http://x") as { paths: Record<string, Record<string, { security?: unknown[]; description: string }>> };
    const open = Object.entries(doc.paths).flatMap(([p, ops]) => Object.entries(ops).filter(([, o]) => Array.isArray(o.security) && !o.security.length).map(([meth]) => `${meth.toUpperCase()} ${p}`));
    expect(open.sort()).toEqual(
      ["POST /auth/login", "POST /auth/login/code", "POST /auth/code/start", "POST /auth/code/verify", "GET /auth/invite", "POST /auth/invite/accept", "POST /auth/refresh", "POST /auth/logout", "POST /auth/wiped", "POST /auth/device/request", "GET /auth/device", "GET /config", "POST /clock/kiosk/pair"].sort(),
    );
    for (const p of ["/banking", "/banking/external-accounts", "/banking/onboarding-link", "/banking/dashboard-link", "/banking/method", "/banking/deposit-consent"])
      expect(Object.values(doc.paths[p])[0].description, p).toMatch(/403 .*FEATURE_STAFF_STRIPE_PAYOUTS=false/);
    const files = STAFF_ROUTE_FILES.map(routePathOf);
    for (const p of ["me/calendar", "me/timecard", "me/earnings", "me/payout-setup", "clients/[id]", "timecards/[id]/approve", "shops/[id]/waitlist", "sales", "manager/board", "config"]) expect(files).toContain(p);
  });
});

describe("config, version gate and switches (ST-I8)", () => {
  it("is open before sign-in, with direct Stripe payouts as the default (payroll where they're switched off) and Tap to Pay off", async () => {
    const r = await call("GET", "config");
    expect(r.status).toBe(200);
    expect(r.json.features).toEqual({ clock: true, stripePayouts: true, tapToPay: false });
    expect(r.json.payouts).toEqual({ defaultMethod: "stripe", stripe: true });
    expect(r.json.links.privacy).toMatch(/\/staff-app\/privacy$/);
    expect(r.json.legal).toMatchObject({ privacy: expect.any(String), terms: expect.any(String) });
  });

  it("an app older than the minimum gets 426 everywhere but /config; the customer app's minimum doesn't apply", async () => {
    withEnv("STAFF_APP_IOS_MIN_VERSION", "2.0.0");
    withEnv("APP_IOS_MIN_VERSION", "9.0.0");
    const t = await login("makenna@rayz.test");
    const old = { "x-client": "ios", "x-app-version": "1.4.0" };
    const me = await call("GET", "me", { token: t.accessToken, headers: old });
    expect(me.status).toBe(426);
    expect(me.json.error).toMatchObject({ code: "upgrade_required", details: { platform: "ios", minVersion: "2.0.0" } });
    expect((await call("POST", "auth/login", { headers: old, body: { email: "makenna@rayz.test", password: "x" } })).status).toBe(426);
    expect((await call("GET", "config", { headers: old })).json.client).toMatchObject({ updateRequired: true });
    expect((await call("GET", "me", { token: t.accessToken, headers: { "x-client": "ios", "x-app-version": "2.0.0" } })).status).toBe(200);
  });

  it("STAFF_APP_CLOCK_OFF stands the app's clock down", async () => {
    withEnv("STAFF_APP_CLOCK_OFF", "true");
    const t = await login("makenna@rayz.test");
    expect((await call("GET", "me", { token: t.accessToken })).json.features.clock).toBe(false);
    const r = await call("POST", "clock/in", { token: t.accessToken, body: { shopId: shop.coralville } });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toMatchObject({ feature: "clock", enabled: false });
  });
});

describe("signing in (ST-C1) and the account lifecycle (ST-C10)", () => {
  it("a code by email signs in; a wrong code doesn't; the answer is the same for nobody", async () => {
    withEnv("AUTH_DEV_CODES", "true");
    const nobody = await call("POST", "auth/code/start", { body: { email: "nobody@rayz.test" } });
    expect(nobody.status).toBe(200);
    expect(nobody.json.devCode).toBeUndefined();
    const start = await call("POST", "auth/code/start", { body: { email: "frontdesk@rayz.test" } });
    expect(start.status, start.text).toBe(200);
    expect(Object.keys(nobody.json).sort()).toEqual(Object.keys(start.json).filter((k) => k !== "devCode").sort());
    const code = start.json.devCode as string;
    expect((await call("POST", "auth/code/verify", { body: { email: "frontdesk@rayz.test", code: code === "000000" ? "111111" : "000000" } })).status).toBe(401);
    const ok = await call("POST", "auth/code/verify", { body: { email: "frontdesk@rayz.test", code, deviceName: "Desk phone" } });
    expect(ok.status, ok.text).toBe(200);
    expect((await call("GET", "me", { token: ok.json.tokens.accessToken })).json.staff.id).toBe(ids.frontdesk);
    expect((await call("POST", "auth/code/verify", { body: { email: "frontdesk@rayz.test", code } })).status).toBe(401);
  });

  it("a refresh token from an install only works with that install's id", async () => {
    const t = await login("regional@rayz.test", { deviceId: "install-A" });
    expect((await call("POST", "auth/refresh", { body: { refreshToken: t.refreshToken } })).status).toBe(401);
    expect((await call("GET", "me", { token: t.accessToken })).status).toBe(401);
    const u = await login("regional@rayz.test", { deviceId: "install-A" });
    const r = await call("POST", "auth/refresh", { body: { refreshToken: u.refreshToken, deviceId: "install-A" } });
    expect(r.status, r.text).toBe(200);
  });

  it("an invite link signs them in once; only someone who manages users sends one", async () => {
    const { sha256 } = await import("@/server/auth/tokens");
    const mgr = await login("makenna@rayz.test");
    expect((await call("POST", `staff/${ids.frontdesk}/app-invite`, { token: mgr.accessToken, body: { channel: "email" } })).status).toBe(403);
    const owner = await login("owner@rayz.test");
    const sent = await call("POST", `staff/${ids.frontdesk}/app-invite`, { token: owner.accessToken, body: { channel: "email" } });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.channel).toBe("email");
    const [job] = await m.db.db.select().from(S().notificationJobs).where(eq(S().notificationJobs.kind, "staff_app_invite")).orderBy(m.drizzle.desc(S().notificationJobs.createdAt)).limit(1);
    expect(job.body).not.toMatch(/staff-app\/invite\/[A-Za-z0-9_-]{20,}/);

    const token = `test-invite-${crypto.randomUUID().replace(/-/g, "")}`;
    await m.db.db.insert(S().staffInvites).values({ staffId: ids.frontdesk, tokenHash: sha256(token), purpose: "staff_app", channel: "email", expiresAt: new Date(Date.now() + 86_400_000), createdBy: ids.owner });
    const view = await call("GET", `auth/invite?token=${token}`);
    expect(view.json).toMatchObject({ firstName: expect.any(String), setPassword: false });
    const used = await call("POST", "auth/invite/accept", { body: { token, deviceName: "New phone" } });
    expect(used.status, used.text).toBe(200);
    expect((await call("GET", "me", { token: used.json.tokens.accessToken })).json.staff.id).toBe(ids.frontdesk);
    expect((await call("POST", "auth/invite/accept", { body: { token } })).status).toBe(404);
    expect((await call("GET", `auth/invite?token=${token}`)).status).toBe(404);
  });

  it("their phones: list, sign one out, sign out the others; a manager signs them out everywhere", async () => {
    const a = await login("frontdesk@rayz.test");
    const b = await login("frontdesk@rayz.test");
    const c = await login("frontdesk@rayz.test");
    const list = (await call("GET", "me/sessions", { token: a.accessToken })).json.sessions as { id: string; current: boolean }[];
    expect(list.find((s) => s.current)?.id).toBe(a.sessionId);
    expect(JSON.stringify(list)).not.toMatch(/ip|token|\d+\.\d+\.\d+\.\d+/i);
    expect((await call("DELETE", `me/sessions/${b.sessionId}`, { token: a.accessToken })).status).toBe(204);
    expect((await call("GET", "me", { token: b.accessToken })).status).toBe(401);
    const other = await login("makenna@rayz.test");
    expect((await call("DELETE", `me/sessions/${other.sessionId}`, { token: a.accessToken })).status).toBe(404);
    expect((await call("GET", "me", { token: other.accessToken })).status).toBe(200);
    expect((await call("POST", "me/sessions/sign-out-others", { token: a.accessToken })).json.ended).toBeGreaterThanOrEqual(1);
    expect((await call("GET", "me", { token: c.accessToken })).status).toBe(401);
    expect((await call("GET", "me", { token: a.accessToken })).status).toBe(200);

    const owner = await login("owner@rayz.test");
    expect((await call("POST", `staff/${ids.frontdesk}/sign-out`, { token: owner.accessToken })).status).toBe(204);
    expect((await call("GET", "me", { token: a.accessToken })).status).toBe(401);
    const audits = await m.db.db.select().from(S().auditLog).where(and(eq(S().auditLog.action, "user.app_sign_out"), eq(S().auditLog.entityId, ids.frontdesk)));
    expect(audits).toHaveLength(1);
  });
});

describe("data on the phone (ST-I18)", () => {
  it("config carries the device policy: an encrypted 24-hour cache, app lock, snapshot blur, no copy or share, read-only offline but for punches, and no biometrics", async () => {
    const r = await call("GET", "config");
    expect(r.json.dataProtection).toMatchObject({
      cache: { encrypted: true, ttlHours: 24, header: "X-Staff-Cache", excludeFromBackup: true },
      appLock: { required: true, afterBackgroundSeconds: 300 },
      snapshotBlur: { required: true },
      copyShare: { blocked: true },
      offline: { mode: "read_only", queued: ["clock_punch"], punchMaxAgeHours: 24 },
      wipe: { onSignOut: true, onRevoke: true },
    });
    expect(r.json.biometrics).toMatchObject({ collected: false });
    expect(r.headers.get("x-staff-cache")).toBe("offline-24h");
  });

  it("only their own day may be kept on the phone; clients, pay and anything sent never are, and nothing goes in an HTTP cache", async () => {
    const t = await login("makenna@rayz.test");
    for (const p of ["me", "me/calendar", "me/timecard", "clock", "schedule"]) {
      const r = await call("GET", p, { token: t.accessToken });
      expect(r.status, p).toBe(200);
      expect(r.headers.get("x-staff-cache"), p).toBe("offline-24h");
      expect(r.headers.get("cache-control"), p).toBe("private, no-store");
    }
    for (const p of ["me/earnings", "tips", "payouts", "clients?q=Od", "me/sessions", "me/notifications"]) {
      const r = await call("GET", p, { token: t.accessToken });
      expect(r.headers.get("x-staff-cache"), `${p} ${r.status}`).toBe("none");
    }
    expect((await call("PUT", "me/notifications", { token: t.accessToken, body: {} })).headers.get("x-staff-cache")).not.toBe("offline-24h");
  });

  it("a refused session says what to wipe: everything when signed out from elsewhere or by a manager, the cache when it only expired, nothing when the token just needs a refresh; the wipe is logged", async () => {
    const reason = async (token: string) => (await call("GET", "me", { token })).json.error.details;
    expect(await reason("not-a-token")).toEqual({ reason: "token_expired", wipe: "none" });

    const a = await login("frontdesk@rayz.test", { deviceId: "wipe-A" });
    const b = await login("frontdesk@rayz.test", { deviceId: "wipe-B" });
    expect((await call("DELETE", `me/sessions/${b.sessionId}`, { token: a.accessToken })).status).toBe(204);
    expect(await reason(b.accessToken)).toEqual({ reason: "session_ended", wipe: "all" });
    const refused = await call("POST", "auth/refresh", { body: { refreshToken: b.refreshToken, deviceId: "wipe-B" } });
    expect(refused.json.error.details).toEqual({ reason: "session_ended", wipe: "all" });
    expect((await call("POST", "auth/refresh", { body: { refreshToken: a.refreshToken, deviceId: "wipe-other" } })).json.error.details).toMatchObject({ reason: "other_device", wipe: "all" });

    const c = await login("frontdesk@rayz.test", { deviceId: "wipe-C" });
    await m.db.db.update(S().staffAppTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(S().staffAppTokens.sessionId, c.sessionId));
    expect(await reason(c.accessToken)).toEqual({ reason: "session_expired", wipe: "cache" });
    expect((await call("POST", "auth/refresh", { body: { refreshToken: c.refreshToken, deviceId: "wipe-C" } })).json.error.details).toEqual({ reason: "session_expired", wipe: "cache" });

    const d = await login("frontdesk@rayz.test", { deviceId: "wipe-D" });
    const owner = await login("owner@rayz.test");
    expect((await call("POST", `staff/${ids.frontdesk}/sign-out`, { token: owner.accessToken })).status).toBe(204);
    expect(await reason(d.accessToken)).toEqual({ reason: "session_ended", wipe: "all" });

    expect((await call("POST", "auth/wiped", { body: { refreshToken: d.refreshToken, wipe: "all" } })).status).toBe(204);
    expect((await call("POST", "auth/wiped", { body: { refreshToken: "nobody-knows-this-token", wipe: "all" } })).status).toBe(204);
    const logs = await m.db.db.select().from(S().auditLog).where(and(eq(S().auditLog.action, "staff.app_wiped"), eq(S().auditLog.entityId, ids.frontdesk)));
    expect(logs.at(-1)?.details).toMatchObject({ sessionId: d.sessionId, wipe: "all" });
    expect(JSON.stringify(logs)).not.toContain(d.refreshToken);
  });
});

describe("the calendar (ST-C3)", () => {
  it("a barber sees their own column; the front desk sees every barber's; no client phone either way", async () => {
    const t = await login("makenna@rayz.test");
    const mine = await appt(ids.makenna);
    const cal = await call("GET", `me/calendar?date=${today}`, { token: t.accessToken, shop: shop.coralville });
    expect(cal.status, cal.text).toBe(200);
    expect(cal.json.allColumns).toBe(false);
    expect(cal.json.columns.map((c: { staffId: string }) => c.staffId)).toEqual([ids.makenna]);
    expect(JSON.stringify(cal.json)).toContain(mine.id);
    for (const s of NEVER) expect(cal.text).not.toContain(s);
    const fd = await login("frontdesk@rayz.test");
    const all = await call("GET", `me/calendar?date=${today}&shopId=${shop.coralville}`, { token: fd.accessToken });
    expect(all.json.allColumns).toBe(true);
    expect(all.json.columns.length).toBeGreaterThan(1);
    for (const s of NEVER) expect(all.text).not.toContain(s);
    expect((await call("GET", `me/calendar?shopId=${shop.moline}`, { token: t.accessToken })).status).toBe(403);
    expect((await call("GET", "me/calendar", { token: t.accessToken, shop: shop.moline })).status).toBe(403);
  });

  it("status changes, running late and moves on their own appointments; another barber's is not found", async () => {
    const t = await login("makenna@rayz.test");
    const mine = await appt(ids.makenna);
    const other = await appt(ids.michelle);
    const late = await call("POST", `appointments/${mine.id}/late`, { token: t.accessToken, body: { minutes: 10 } });
    expect(late.status, late.text).toBe(200);
    const chk = await call("POST", `appointments/${mine.id}/status`, { token: t.accessToken, body: { action: "check_in" } });
    expect(chk.status, chk.text).toBe(200);
    expect(chk.json.status).toBe("checked_in");
    expect([403, 404]).toContain((await call("POST", `appointments/${other.id}/status`, { token: t.accessToken, body: { action: "cancel" } })).status);
    expect((await m.db.db.query.appointments.findFirst({ where: eq(S().appointments.id, other.id) }))!.status).toBe("booked");
    expect((await call("POST", `appointments/${mine.id}/status`, { token: t.accessToken, body: { action: "delete" } })).status).toBe(400);
    const audits = await m.db.db.select().from(S().auditLog).where(and(eq(S().auditLog.entityId, mine.id), eq(S().auditLog.action, "appointment.running_late")));
    expect(audits).toHaveLength(1);
  });

  it("books into their own column from the openings, and blocks and unblocks their own time", async () => {
    const t = await login("makenna@rayz.test");
    let booked: { id: string } | null = null;
    for (let i = 2; i < 30 && !booked; i++) {
      const date = m.time.addDays(today, i);
      const o = await call("GET", `openings?date=${date}&serviceId=${ids.service}`, { token: t.accessToken, shop: shop.coralville });
      expect(o.status, o.text).toBe(200);
      if (!o.json.starts.length) continue;
      const r = await call("POST", "appointments", { token: t.accessToken, shop: shop.coralville, body: { date, startMin: o.json.starts[0], serviceId: ids.service, customerId: ids.client } });
      expect(r.status, r.text).toBe(201);
      booked = r.json;
      expect((await call("GET", `openings?date=${date}&serviceId=${ids.service}&staffId=${ids.michelle}`, { token: t.accessToken, shop: shop.coralville })).status).toBe(403);
      const theirs = await call("POST", "appointments", { token: t.accessToken, shop: shop.coralville, body: { date, startMin: o.json.starts.at(-1), serviceId: ids.service, customerId: ids.client, staffId: ids.michelle } });
      expect(theirs.status).toBe(403);
    }
    expect(booked).not.toBeNull();
    const reason = (await m.db.db.query.blockReasons.findFirst({ where: eq(S().blockReasons.key, "personal") }))!;
    const date = m.time.addDays(today, 40);
    const b = await call("POST", "blocks", { token: t.accessToken, shop: shop.coralville, body: { date, startMin: 6 * 60, endMin: 6 * 60 + 30, reasonId: reason.id } });
    expect(b.status, b.text).toBe(201);
    expect(b.json.saved).toBe(true);
    expect((await call("DELETE", `blocks/${b.json.blockId}`, { token: t.accessToken })).status).toBe(204);
  });
});

describe("the client card (ST-C4) and the shop line (ST-I5)", () => {
  it("search and the card follow Client data protection: no contact details ever, masked stays masked, every look logged", async () => {
    const t = await login("makenna@rayz.test");
    await appt(ids.makenna, { status: "completed" });
    const found = await call("GET", `clients?q=${CLIENT.first}`, { token: t.accessToken });
    expect(found.status, found.text).toBe(200);
    expect(found.json.clients.map((c: { id: string }) => c.id)).toContain(ids.client);
    const card = await call("GET", `clients/${ids.client}`, { token: t.accessToken });
    expect(card.status, card.text).toBe(200);
    expect(card.json.contact).toMatchObject({ hasPhone: true, hasEmail: true });
    for (const s of [...NEVER, CLIENT.last]) {
      expect(card.text, s).not.toContain(s);
      expect(found.text, s).not.toContain(s);
    }
    expect(card.json.fields.every((f: { level: string }) => f.level !== "hidden")).toBe(true);
    const logs = await m.db.db.select().from(S().clientAccessLog).where(and(eq(S().clientAccessLog.customerId, ids.client), eq(S().clientAccessLog.staffId, ids.makenna)));
    expect(logs.some((l) => (l.detail as { via?: string } | null)?.via === "staff_app")).toBe(true);

    for (const field of ["phone", "email", "address"]) {
      const r = await call("POST", `clients/${ids.client}/reveal`, { token: (await login("owner@rayz.test")).accessToken, body: { field, reason: "Checking the number" } });
      expect(r.status, field).toBe(404);
    }
    expect((await call("GET", `clients/${crypto.randomUUID()}`, { token: t.accessToken })).status).toBe(404);
  });

  it("texts through the shop's number without the number coming back, and only with clients.message", async () => {
    const fd = await login("frontdesk@rayz.test");
    const r = await call("POST", `clients/${ids.client}/contact`, { token: fd.accessToken, body: { channel: "sms", message: "Your barber is running 10 minutes behind." } });
    expect(r.status, r.text).toBe(200);
    for (const s of NEVER) expect(r.text).not.toContain(s);
    await setOverrides("frontdesk", { "clients.message": false });
    onTestFinished(async () => {
      await setOverrides("frontdesk", {});
    });
    expect((await call("POST", `clients/${ids.client}/contact`, { token: fd.accessToken, body: { channel: "call" } })).status).toBe(403);
  });
});

describe("timecards (ST-C5)", () => {
  it("a manager adds, edits and voids punches with a reason; the barber signs off; the manager approves; no photo or location comes back", async () => {
    const mgr = await login("michelle@rayz.test");
    const t = await login("makenna@rayz.test");
    // A day in the last pay period: the seed leaves her clocked in today, which would hold up sign-off.
    const { periodFor } = await import("@/server/time-clock");
    const day = m.time.addDays((await periodFor(today)).start, -1);
    const at = (min: number) => m.time.zonedWallTime(day, min).toJSDate().toISOString();
    const add = async (type: string, min: number) => call("POST", `timecards/${ids.makenna}/punches`, { token: mgr.accessToken, body: { shopId: shop.coralville, type, at: at(min), reason: "Forgot to punch" } });
    const inn = await add("in", 9 * 60);
    expect(inn.status, inn.text).toBe(201);
    const out = await add("out", 17 * 60);
    expect(out.status, out.text).toBe(201);
    const extra = await add("in", 18 * 60);
    expect((await call("PATCH", `punches/${out.json.id}`, { token: mgr.accessToken, body: { at: at(17 * 60 + 15), reason: "Stayed late for a walk-in" } })).status).toBe(200);
    expect((await call("POST", `punches/${extra.json.id}/void`, { token: mgr.accessToken, body: { reason: "Duplicate" } })).status).toBe(204);
    expect((await call("POST", `timecards/${ids.makenna}/punches`, { token: t.accessToken, body: { shopId: shop.coralville, type: "in", at: at(8 * 60), reason: "x" } })).status).toBe(403);

    const team = await call("GET", `timecards/${ids.makenna}?period=${day}`, { token: mgr.accessToken });
    expect(team.status, team.text).toBe(200);
    expect(team.json.punches.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([inn.json.id, out.json.id]));
    expect(team.json.punches.find((p: { id: string }) => p.id === extra.json.id).voided).toBe(true);

    const mine = await call("GET", `me/timecard?period=${day}`, { token: t.accessToken });
    expect(mine.status, mine.text).toBe(200);
    for (const k of ["photo", "dataUrl", "latitude", "longitude", "distanceM", "\"ip\""]) {
      expect(mine.text).not.toContain(k);
      expect(team.text).not.toContain(k);
    }
    const periodStart = mine.json.period.start as string;
    const so = await call("POST", "me/timecard/sign-off", { token: t.accessToken, body: { shopId: shop.coralville, periodStart } });
    expect(so.status, so.text).toBe(200);
    const ap = await call("POST", `timecards/${ids.makenna}/approve`, { token: mgr.accessToken, body: { shopId: shop.coralville, periodStart } });
    expect(ap.status, ap.text).toBe(200);
    expect(ap.json.shops.find((s: { shopId: string }) => s.shopId === shop.coralville).approval.managerAt).toBeTruthy();

    const list = await call("GET", `timecards?period=${periodStart}`, { token: mgr.accessToken });
    expect(list.json.rows.some((r: { staffId: string }) => r.staffId === ids.makenna)).toBe(true);
    expect((await call("GET", "timecards", { token: t.accessToken })).status).toBe(403);
  });

  it("exports the iSolved CSV with payroll.export only", async () => {
    const owner = await login("owner@rayz.test");
    const r = await call("GET", `timecards/export?period=${m.time.addDays(today, -1)}&shopId=${shop.coralville}`, { token: owner.accessToken });
    const { periodFor } = await import("@/server/time-clock");
    const p = (await periodFor(m.time.addDays(today, -1))).start;
    const ok = r.status === 200 ? r : await call("GET", `timecards/export?period=${p}&shopId=${shop.coralville}`, { token: owner.accessToken });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/csv/);
    expect(ok.headers.get("content-disposition")).toMatch(/rayz-payroll-.*\.csv/);
    expect((await call("GET", `timecards/export?period=${p}`, { token: (await login("makenna@rayz.test")).accessToken })).status).toBe(403);
  });
});

describe("earnings (ST-C6) and tip payouts (ST-C7)", () => {
  it("each shop's numbers are the barber's line of the payroll run, to the cent", async () => {
    const t = await login("makenna@rayz.test");
    const r = await call("GET", `me/earnings?period=${today}`, { token: t.accessToken });
    expect(r.status, r.text).toBe(200);
    const cv = r.json.shops.find((s: { shopId: string }) => s.shopId === shop.coralville);
    const { buildPayroll } = await import("@/server/payroll/run");
    const run = await buildPayroll(cv.period.start, cv.period.end);
    const line = run!.blocks.find((b) => b.shopId === shop.coralville)?.lines.find((l) => l.staffId === ids.makenna);
    const c = (x: number | undefined) => Math.round((x ?? 0) * 100);
    expect(cv.tips.totalCents).toBe(c(line?.tips));
    expect(cv.tips.inPayrollCents).toBe(c(line?.tipsInPayroll));
    expect(cv.sales).toEqual({ serviceNetCents: c(line?.service), productNetCents: c(line?.product) });
    expect(cv.hours.regular).toBe(line?.hours ?? 0);
    expect(cv.tips.cardCents + cv.tips.cashCents + cv.tips.giftCardCents + cv.tips.adjustmentsCents).toBe(cv.tips.totalCents);
    expect(r.json.payout.defaultMethod).toBe("stripe");
    const block = run!.blocks.find((b) => b.shopId === shop.coralville)!;
    const { paystubLines } = await import("@/domain/payroll/calc");
    expect(cv.paystub).toEqual(JSON.parse(JSON.stringify(paystubLines(block, ids.makenna).filter((l) => r.json.sees[l.group]))));
    if (line?.hours) expect(cv.paystub).toContainEqual(expect.objectContaining({ header: "E_Regular_Hours", name: "Regular", unit: "hours", amount: line.hours }));

    await setOverrides("makenna", { "reports.money": false, "compensation.own": false });
    onTestFinished(async () => {
      await setOverrides("makenna", {});
    });
    const less = (await call("GET", "me/earnings", { token: t.accessToken })).json;
    expect(less.shops[0].sales).toBeNull();
    expect(less.shops[0].wages).toBeNull();
    expect(less.shops[0].paystub.every((l: { group: string }) => l.group !== "wages")).toBe(true);
    expect(less.shops[0].tips).not.toBeNull();
  });

  it("year to date adds what came over from Squire", async () => {
    const owner = await login("owner@rayz.test");
    const { importYtd } = await import("@/server/payout-cutover");
    const y = Number(today.slice(0, 4));
    const code = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.id, ids.makenna), columns: { staffCode: true } }))!.staffCode!;
    const res = await importYtd({ staffId: ids.owner, label: "owner" }, shop.coralville, { year: y, throughDate: `${y}-01-31`, csv: `barber,card_tips,cash_tips,service_sales,product_sales,paid_out\n${code},"1,200.50",300,9000,450.25,1500.75\nNobody Here,1,1,1,1,1` });
    expect(res).toEqual({ imported: 1, unmatched: [3], invalid: [] });
    void owner;
    const t = await login("makenna@rayz.test");
    const ytd = await call("GET", `me/earnings/ytd?year=${y}`, { token: t.accessToken });
    expect(ytd.status, ytd.text).toBe(200);
    const cv = ytd.json.shops.find((s: { shopId: string }) => s.shopId === shop.coralville);
    expect(cv.squire).toMatchObject({ cardTipsCents: 120050, cashTipsCents: 30000, serviceSalesCents: 900000, productSalesCents: 45025, paidOutCents: 150075 });
    expect(ytd.json.totals.cardTipsCents).toBe(cv.rayz.cardTipsCents + 120050);
  });

  it("payout setup says Stripe to their own bank by default and payroll where it's switched off, W-2 wages either way, and never a bank number", async () => {
    const t = await login("makenna@rayz.test");
    const r = await call("GET", "me/payout-setup", { token: t.accessToken });
    expect(r.status, r.text).toBe(200);
    expect(r.json.defaultMethod).toBe("stripe");
    expect(r.json.stripePayouts).toEqual({ enabled: true });
    expect(r.json.shops.every((s: { method: string; path: string }) => s.method === "stripe" && /W-2/.test(s.path))).toBe(true);
    expect(r.text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")).not.toMatch(/routing|account_number|\d{8,}/);
    withEnv("FEATURE_STAFF_STRIPE_PAYOUTS", "false");
    const off = (await call("GET", "me/payout-setup", { token: t.accessToken })).json;
    expect(off.defaultMethod).toBe("payroll");
    expect(off.stripePayouts).toMatchObject({ enabled: false, message: expect.stringMatching(/payroll/) });
    expect(off.shops.every((s: { method: string }) => s.method !== "stripe")).toBe(true);
    expect((await call("GET", "config")).json.payouts).toEqual({ defaultMethod: "payroll", stripe: false });
  });
});

describe("the Squire payout cutover (ST-C9)", () => {
  it("Squire-owed tips per barber, the barber confirms or disputes their own line, and a dispute holds the manager's sign-off; then the checklist: Saturday close, one owner per tip date, a three-way tie-out, the manager and then the CPA", async () => {
    const { payoutCutoverReport, setPayoutCutoverDates, signOffPayoutReport, recordCpaSignOff } = await import("@/server/payout-cutover");
    const { setSquireTipsEnd } = await import("@/server/tips/onboarding");
    const cv = shop.coralville;
    const michelle = { staffId: ids.michelle, label: "michelle" };
    const back = m.time.addDays(today, -7);
    const end = m.time.addDays(back, -((m.time.weekdayOf(back) + 1) % 7));
    expect(m.time.weekdayOf(end)).toBe(6);
    const d = (n: number) => m.time.addDays(end, n);
    await expect(setSquireTipsEnd(michelle, cv, d(-1))).rejects.toThrow(/Saturday/);
    await setSquireTipsEnd(michelle, cv, end);
    const sale = (day: number, tipCents: number) => ({ shopId: cv, staffId: ids.makenna, businessDate: d(day), status: "paid" as const, isImported: true, tipCents, totalCents: 4000 + tipCents });
    const [, , , after] = await m.db.db.insert(S().sales).values([sale(-8, 999), sale(-2, 700), sale(-1, 550), sale(1, 5000)]).returning({ id: S().sales.id });
    await setPayoutCutoverDates(michelle, cv, { paidThrough: d(-3), lastPayoutOn: d(5) });
    const report = await payoutCutoverReport(cv);
    const line = report.lines.find((l) => l.staffId === ids.makenna)!;
    expect(line).toMatchObject({ squireOwedCents: 1250, tickets: 2, confirmation: null });
    expect(report.firstRayzPayout).toMatchObject({ via: "stripe" });
    expect(report.ready).toBe(true);
    expect(report.saturdayClose).toBe(true);
    expect(report.owners.squireAfterEnd).toEqual({ tickets: 1, tipCents: 5000 });
    expect(report.owners.rayzInSquireDays).toEqual({ tickets: 0, tipCents: 0 });

    // A ticket paid with a payment the import wrote is Squire's too, not one Ray'z owes.
    const [paidInSquire] = await m.db.db.insert(S().sales).values({ ...sale(-2, 300), isImported: false }).returning({ id: S().sales.id });
    await m.db.db.insert(S().payments).values({ saleId: paidInSquire.id, shopId: cv, businessDate: d(-2), method: "card", amountCents: 4300, tipCents: 300, processor: "squire_import" });
    const withPayment = await payoutCutoverReport(cv);
    expect(withPayment.lines.find((l) => l.staffId === ids.makenna)).toMatchObject({ squireOwedCents: 1550, tickets: 3 });
    expect(withPayment.owners.rayzInSquireDays).toEqual({ tickets: 0, tipCents: 0 });
    await m.db.db.delete(S().payments).where(eq(S().payments.saleId, paidInSquire.id));
    await m.db.db.delete(S().sales).where(eq(S().sales.id, paidInSquire.id));

    expect(report.checklist.map((x) => [x.key, x.done])).toEqual([
      ["saturday_close", true],
      ["squire_dates", true],
      ["one_owner", false],
      ["tie_out", false],
      ["barbers", false],
      ["manager", false],
      ["cpa", false],
      ["ytd", expect.any(Boolean)],
    ]);

    const t = await login("makenna@rayz.test");
    const mine = await call("GET", "me/payout-cutover", { token: t.accessToken });
    expect(mine.json.shops).toEqual([expect.objectContaining({ shopId: cv, squireOwedCents: 1250, needsAnswer: true })]);
    expect(JSON.stringify(mine.json)).not.toContain(ids.michelle);
    expect((await call("POST", "me/payout-cutover/confirm", { token: t.accessToken, body: { shopId: cv, status: "disputed" } })).status).toBe(400);
    expect((await call("POST", "me/payout-cutover/confirm", { token: t.accessToken, body: { shopId: shop.moline, status: "confirmed" } })).status).toBe(403);
    const disp = await call("POST", "me/payout-cutover/confirm", { token: t.accessToken, body: { shopId: cv, status: "disputed", note: "I had a $20 cash tip on the 3rd" } });
    expect(disp.status, disp.text).toBe(200);
    await expect(signOffPayoutReport(michelle, cv)).rejects.toThrow(/dispute/);
    await call("POST", "me/payout-cutover/confirm", { token: t.accessToken, body: { shopId: cv, status: "confirmed" } });
    const others = (await payoutCutoverReport(cv)).lines.filter((l) => l.staffId !== ids.makenna);
    for (const o of others) await m.db.db.insert(S().staffPayoutConfirmations).values({ shopId: cv, staffId: o.staffId, status: "confirmed", squireOwedCents: o.squireOwedCents, decidedAt: new Date() }).onConflictDoNothing();

    // A Squire ticket after Squire stops has nobody to pay it; the statement has to agree with the tickets.
    await expect(signOffPayoutReport(michelle, cv)).rejects.toThrow(/after Squire stops/);
    await m.db.db.delete(S().sales).where(eq(S().sales.id, after.id));
    await expect(signOffPayoutReport(michelle, cv)).rejects.toThrow(/final statement/);
    await setPayoutCutoverDates(michelle, cv, { paidThrough: d(-3), lastPayoutOn: d(5), statementCents: 1200 });
    await expect(signOffPayoutReport(michelle, cv)).rejects.toThrow(/\$12\.00 but its tickets say \$12\.50/);
    await setPayoutCutoverDates(michelle, cv, { paidThrough: d(-3), lastPayoutOn: d(5), statementCents: 1250 });
    expect((await payoutCutoverReport(cv)).tieOut).toEqual({ ticketsCents: 1250, statementCents: 1250, confirmedCents: 1250, matched: true });

    const owner = { staffId: null, label: "owner" };
    await expect(recordCpaSignOff(owner, cv, { name: "Pat Lee, CPA", signedOn: today })).rejects.toThrow(/manager signs the tie-out first/);
    const signed = await signOffPayoutReport(michelle, cv);
    expect(signed.signedOff).toMatchObject({ current: true });
    await expect(recordCpaSignOff(owner, cv, { name: "Pat Lee, CPA", signedOn: m.time.addDays(today, 1) })).rejects.toThrow(/today or earlier/);
    const cpa = await recordCpaSignOff(owner, cv, { name: "Pat Lee, CPA", signedOn: today });
    expect(cpa.cpa).toMatchObject({ name: "Pat Lee, CPA", signedOn: today, current: true });
    expect(cpa.checklist.filter((x) => !x.done).map((x) => x.key)).toEqual(cpa.checklist.find((x) => x.key === "ytd")!.done ? [] : ["ytd"]);
    const [trail] = await m.db.db.select().from(S().auditLog).where(and(eq(S().auditLog.action, "cutover.cpa_sign_off"), eq(S().auditLog.entityId, cv)));
    expect(trail.details).toMatchObject({ cpa: "Pat Lee, CPA", statementCents: 1250 });

    await m.db.db.insert(S().sales).values(sale(-1, 100));
    const changed = await payoutCutoverReport(cv);
    expect(changed.signedOff?.current).toBe(false);
    expect(changed.cpa?.current).toBe(false);
    expect(changed.tieOut.matched).toBe(false);
  });
});

describe("time off (ST-I1) and milestones (ST-I2)", () => {
  it("a barber asks, the manager approves with a push, and it becomes a block; someone else can't decide", async () => {
    const t = await login("makenna@rayz.test");
    const mine = await call("GET", "me/time-off-requests", { token: t.accessToken });
    expect(mine.status).toBe(200);
    const reasonId = mine.json.reasons[0].id as string;
    const from = m.time.addDays(today, 60);
    const ask = await call("POST", "me/time-off-requests", { token: t.accessToken, body: { shopId: shop.coralville, fromDate: from, toDate: from, allDay: true, reasonId, confirm: true } });
    expect(ask.status, ask.text).toBe(201);
    const id = ask.json.requestId as string;
    expect((await call("POST", `time-off-requests/${id}/decision`, { token: t.accessToken, body: { decision: "approve" } })).status).toBe(403);
    const mgr = await login("michelle@rayz.test");
    const pending = await call("GET", "time-off-requests", { token: mgr.accessToken });
    expect(pending.json.requests.map((r: { id: string }) => r.id)).toContain(id);
    const moline = await login("manager.moline@rayz.test");
    expect((await call("POST", `time-off-requests/${id}/decision`, { token: moline.accessToken, body: { decision: "deny" } })).status).toBe(404);
    const ok = await call("POST", `time-off-requests/${id}/decision`, { token: mgr.accessToken, body: { decision: "approve" } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.status).toBe("approved");
    const blocks = await m.db.db.select().from(S().timeBlocks).where(eq(S().timeBlocks.staffId, ids.makenna));
    expect(blocks.some((b) => m.time.localDateOf(b.startsAt) === from)).toBe(true);
    expect((await call("DELETE", `me/time-off-requests/${id}`, { token: (await login("frontdesk@rayz.test")).accessToken })).status).toBe(404);
  });

  it("milestones show teammates' only with reports.all_staff", async () => {
    const t = await login("makenna@rayz.test");
    const r = await call("GET", "me/milestones", { token: t.accessToken });
    expect(r.status, r.text).toBe(200);
    if (r.json.enabled) expect(r.json.team).toBeNull();
  });
});

describe("walk-ins (ST-I3), checkout (ST-I4), the kiosk (ST-I6) and the manager's board (ST-I7)", () => {
  it("the waitlist never shows a phone; seating, texting and leaving work at their shop only", async () => {
    const fd = await login("frontdesk@rayz.test");
    const add = await call("POST", `shops/${shop.coralville}/waitlist`, { token: fd.accessToken, body: { serviceId: ids.service, name: `${CLIENT.first} ${CLIENT.last}`, phone: "3195558421", preferredStaffId: ids.makenna } });
    expect(add.status, add.text).toBe(201);
    const list = await call("GET", `shops/${shop.coralville}/waitlist`, { token: fd.accessToken });
    expect(list.status).toBe(200);
    for (const s of NEVER) expect(list.text).not.toContain(s);
    if (!add.json.seated) {
      const entry = list.json.entries.find((e: { id: string }) => e.id === add.json.entryId);
      expect(entry.canText).toBe(true);
      expect((await call("POST", `waitlist/${add.json.entryId}/notify`, { token: fd.accessToken })).status).toBe(200);
      expect((await call("POST", `waitlist/${add.json.entryId}/status`, { token: fd.accessToken, body: { status: "left" } })).status).toBe(204);
    }
    expect((await call("GET", `shops/${shop.moline}/waitlist`, { token: fd.accessToken })).status).toBe(403);
    await setOverrides("frontdesk", { "walkins.manage": false });
    onTestFinished(async () => {
      await setOverrides("frontdesk", {});
    });
    expect((await call("GET", `shops/${shop.coralville}/waitlist`, { token: fd.accessToken })).status).toBe(403);
  });

  it("a sale for their own appointment is priced by the server with the credit card fee; Tap to Pay is off until switched on", async () => {
    const t = await login("makenna@rayz.test");
    const a = await appt(ids.makenna);
    const r = await call("POST", "sales", { token: t.accessToken, body: { appointmentId: a.id, tipCents: 500 } });
    expect(r.status, r.text).toBe(201);
    expect(r.json.totals.totalCents).toBeGreaterThan(0);
    expect(r.json.tapToPay).toEqual({ enabled: false });
    for (const s of NEVER) expect(r.text).not.toContain(s);
    const theirs = await appt(ids.michelle);
    expect([403, 404]).toContain((await call("POST", "sales", { token: t.accessToken, body: { appointmentId: theirs.id } })).status);
    const off = await call("POST", "terminal/connection-token", { token: t.accessToken, body: { shopId: shop.coralville } });
    expect(off.status).toBe(403);
    expect(off.json.error.details).toMatchObject({ feature: "tap_to_pay" });
  });

  it("the kiosk shows the QR, the team and the walk-in queue with first names only", async () => {
    const shopLogin = await login("coralville@rayz.test");
    const mgr = await login("michelle@rayz.test");
    const reg = await call("POST", "clock/kiosk/register", { token: mgr.accessToken, body: { shopId: shop.coralville, label: "Desk iPad" } });
    expect(reg.status, reg.text).toBe(201);
    const device = { "x-clock-device": reg.json.token as string };
    await m.db.db.insert(S().waitlistEntries).values({ shopId: shop.coralville, name: `${CLIENT.first} ${CLIENT.last}`, phone: CLIENT.phone });
    const home = await call("GET", "clock/kiosk", { token: shopLogin.accessToken, headers: device });
    expect(home.status, home.text).toBe(200);
    expect(home.json.qr.url).toContain(shop.coralville);
    expect(home.json.queue.queue.some((q: { firstName: string }) => q.firstName === CLIENT.first)).toBe(true);
    for (const s of [...NEVER, CLIENT.last]) expect(home.text).not.toContain(s);
    expect((await call("GET", "clock/kiosk/queue", { token: shopLogin.accessToken, headers: device })).status).toBe(200);
    expect((await call("GET", "clock/kiosk", { token: shopLogin.accessToken })).status).toBe(403);
  });

  it("the board shows only the parts the manager may see; a barber has none", async () => {
    const mgr = await login("michelle@rayz.test");
    const r = await call("GET", `manager/board?shopId=${shop.coralville}`, { token: mgr.accessToken });
    expect(r.status, r.text).toBe(200);
    expect(r.json.sees.calendar).toBe(true);
    expect(r.json.barbers.length).toBeGreaterThan(0);
    for (const s of NEVER) expect(r.text).not.toContain(s);
    expect((await call("GET", `manager/board?shopId=${shop.moline}`, { token: mgr.accessToken })).status).toBe(403);
    expect((await call("GET", "manager/board", { token: (await login("makenna@rayz.test")).accessToken, shop: shop.coralville })).status).toBe(403);
  });
});

describe("privacy across a barber's whole app", () => {
  it("no client phone, email, address or masked last name in anything a barber's phone receives", async () => {
    const t = await login("makenna@rayz.test");
    await appt(ids.makenna);
    const o = { token: t.accessToken, shop: shop.coralville };
    const texts: string[] = [];
    for (const p of [
      "me",
      `me/calendar?date=${today}`,
      `appointments?from=${today}&days=7`,
      `schedule?from=${today}`,
      `clients?q=${CLIENT.first}`,
      `clients/${ids.client}`,
      "me/timecard",
      "me/earnings",
      "me/earnings/ytd",
      "me/payout-setup",
      "me/payout-cutover",
      "me/milestones",
      "me/time-off-requests",
      "tips",
      "payouts",
      "popups",
      "clock",
    ]) {
      const r = await call("GET", p, o);
      expect(r.status, `${p} ${r.text}`).toBe(200);
      texts.push(r.text);
    }
    const all = texts.join("\n");
    for (const s of [...NEVER, CLIENT.last]) expect(all, s).not.toContain(s);
    expect(all).not.toMatch(/"phone"\s*:\s*"\+?\d/);
    expect(all).not.toMatch(/"email"\s*:\s*"[^"]+@/);
    void actor;
  });
});
