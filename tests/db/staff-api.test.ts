/**
 * The staff app's API (/api/staff/v1) against a real database: email and password sign-in apart
 * from the customer app, with the authenticator step, rotating refresh tokens whose reuse ends every
 * session, and signing out everywhere; a barber sees only their own appointments and the client
 * notes their role allows; the time clock takes the front-desk QR code, the NFC sticker and the
 * front-desk tablet with a PIN, never anything biometric; tips, earnings and payouts follow each
 * permission; Stripe payout setup keeps the account id, status and last 4 only; pop-ups; and the
 * phone gets a push for its barber's new and cancelled bookings until it signs out.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

const PASSWORD = process.env.SEED_PASSWORD ?? "rayz2026!";
const PIN = process.env.SEED_CLOCK_PIN ?? "2468";
const BASE = "http://localhost/api/staff/v1";

let m: Mods;
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteMod = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>;
const routes: Record<string, RouteMod> = {};
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
let coralvilleClock: Record<string, unknown>;
let today = "";
let slot = 0;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;

const ROUTE_DIR = join(process.cwd(), "src/app/api/staff/v1");
const ROUTE_FILES: string[] = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : [];
  });
})(ROUTE_DIR);
/** "appointments/[id]/notes" for its route file. */
const pathOf = (file: string) => relative(ROUTE_DIR, file).split(sep).slice(0, -1).join("/");

async function call(method: keyof RouteMod, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const [bare, search] = path.split("?");
  const parts = bare.split("/").filter(Boolean);
  const key = Object.keys(routes).find((k) => {
    const ks = k.split("/").filter(Boolean);
    return ks.length === parts.length && ks.every((s, i) => s.startsWith("[") || s === parts[i]);
  });
  if (!key) throw new Error(`no route for ${path}`);
  const params = Object.fromEntries(key.split("/").flatMap((s, i) => (s.startsWith("[") ? [[s.slice(1, -1), parts[i]]] : [])));
  const handler = routes[key][method];
  if (!handler) throw new Error(`no ${method} on ${key}`);
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) };
  const res = await handler(new Request(`${BASE}/${bare}${search ? `?${search}` : ""}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(params) });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
}

async function login(email: string) {
  const r = await call("POST", "auth/login", { body: { email, password: PASSWORD, deviceName: "Test phone" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.tokens as { accessToken: string; refreshToken: string; sessionId: string };
}

async function client(lastName: string) {
  const [c] = await m.db.db.insert(S().customers).values({ firstName: "Nola", lastName, homeShopId: shop.coralville }).returning();
  return c;
}

/** Today before opening, so it never meets the seeded book. */
async function appt(customerId: string, staffId: string) {
  const startsAt = m.time.zonedWallTime(today, 30 + 35 * slot++).toJSDate();
  const [a] = await m.db.db
    .insert(S().appointments)
    .values({
      code: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: shop.coralville,
      staffId,
      customerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: "booked",
      source: "staff",
      estimateCents: 3500,
    })
    .returning();
  return a;
}

const setOverrides = (who: string, o: Record<string, boolean>) => m.db.db.update(S().staff).set({ permissionOverrides: o }).where(eq(S().staff.id, ids[who]));
const qrOf = async (url: string) => new URL(url).searchParams;

beforeAll(async () => {
  m = await loadModules();
  for (const file of ROUTE_FILES) routes[pathOf(file)] = (await import(/* @vite-ignore */ file)) as RouteMod;
  for (const k of ["owner", "regional", "michelle", "frontdesk", "makenna", "kat", "coralville"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(S().shops)) shop[s.slug] = s.id;
  const other = await m.db.db
    .select({ id: S().staff.id })
    .from(S().staffShops)
    .innerJoin(S().staff, eq(S().staff.id, S().staffShops.staffId))
    .where(m.drizzle.and(eq(S().staffShops.shopId, shop.coralville), eq(S().staff.kind, "person"), eq(S().staff.isBookable, true), m.drizzle.notInArray(S().staff.id, [ids.makenna, ids.michelle, ids.frontdesk])))
    .limit(1);
  ids.other = other[0].id;
  coralvilleClock = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.id, shop.coralville) }))!.timeClock as Record<string, unknown>;
  today = m.time.todayLocal();
}, 240_000);

// Sign-ins here come from one address in moments; the per-network limit is tested on its own.
beforeEach(async () => {
  await m.db.db.delete(S().apiRateEvents);
});

afterAll(async () => {
  if (!m) return;
  await m.db.db.update(S().shops).set({ timeClock: coralvilleClock }).where(eq(S().shops.id, shop.coralville));
  await m.db.db.update(S().staff).set({ permissionOverrides: {} });
  await m.db.closeDb();
});

describe("the route files", () => {
  it("each one's methods are in the OpenAPI document, and every path there has a route", async () => {
    const { STAFF_API_PATHS } = await import("@/server/staff-api/openapi");
    const fromFiles = ROUTE_FILES.filter((f) => !f.includes("openapi.json")).flatMap((f) => {
      const src = readFileSync(f, "utf8");
      const path = `/${pathOf(f).replace(/\[(\w+)\]/g, "{$1}")}`;
      return [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) =/g)].map((x) => `${x[1]} ${path}`);
    });
    expect([...fromFiles].sort()).toEqual([...STAFF_API_PATHS].sort());
    for (const f of ROUTE_FILES) expect(readFileSync(f, "utf8"), f).toMatch(/export const OPTIONS|openapi/);
  });

  it("serves the OpenAPI document with each path's permission", async () => {
    const r = await call("GET", "openapi.json");
    expect(r.status).toBe(200);
    expect(r.json.openapi).toMatch(/^3\.1/);
    expect(Object.keys(r.json.paths)).toContain("/clock/punch");
    expect(JSON.stringify(r.json)).not.toMatch(/biometric_template|faceId/i);
  });
});

describe("signing in", () => {
  it("takes a staff email and password, not a customer's token", async () => {
    const bad = await call("POST", "auth/login", { body: { email: "makenna@rayz.test", password: "wrong-password" } });
    expect(bad.status).toBe(401);
    expect(bad.json.tokens).toBeUndefined();

    const jordan = (await m.db.db.query.customers.findFirst({ where: eq(S().customers.phone, "+13195550100") }))!;
    const customerToken = (await m.auth.issueTokens(jordan.id, null)).accessToken;
    expect((await call("GET", "me", { token: customerToken })).status).toBe(401);
    expect((await call("GET", "me")).status).toBe(401);

    const t = await login("makenna@rayz.test");
    const me = await call("GET", "me", { token: t.accessToken });
    expect(me.status).toBe(200);
    expect(me.json.staff).toMatchObject({ id: ids.makenna, kind: "person" });
    expect(me.json.features).toMatchObject({ schedule: true, clock: true, tips: true, payouts: true, banking: true, seeEveryCalendar: false });
    expect(me.json.permissions).toContain("timeclock.punch");
    expect(me.json.shops.map((s: { id: string }) => s.id)).toContain(shop.coralville);
    const audits = await m.db.db.select().from(S().auditLog).where(m.drizzle.and(eq(S().auditLog.action, "staff.login"), eq(S().auditLog.entityId, ids.makenna)));
    expect(audits.at(-1)?.details).toMatchObject({ via: "staff_app", deviceName: "Test phone" });
  });

  it("asks for the authenticator code when they have two-step sign-in, and a wrong code can try again", async () => {
    const { totpCode } = await import("@/lib/totp");
    await m.db.db.update(S().staff).set({ twoFactorRequired: true }).where(eq(S().staff.id, ids.kat));
    const first = await call("POST", "auth/login", { body: { email: "kat@rayz.test", password: PASSWORD } });
    expect(first.status).toBe(200);
    expect(first.json.tokens).toBeUndefined();
    const { ticket, enroll } = first.json.twoFactor;
    const secret = (enroll.secret as string).replace(/\s/g, "");
    const right = totpCode(secret);
    const wrong = await call("POST", "auth/login/code", { body: { ticket, code: right === "000000" ? "111111" : "000000" } });
    expect(wrong.status).toBe(401);
    const ok = await call("POST", "auth/login/code", { body: { ticket: wrong.json.error.details?.twoFactor?.ticket ?? ticket, code: right } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await call("GET", "me", { token: ok.json.tokens.accessToken })).json.staff.id).toBe(ids.kat);
    await m.db.db.update(S().staff).set({ twoFactorRequired: false, totpSecret: null, totpEnabledAt: null }).where(eq(S().staff.id, ids.kat));
  });

  it("rotates refresh tokens; reusing an old one ends every session", async () => {
    const a = await login("regional@rayz.test");
    const b = await login("regional@rayz.test");
    const a2 = (await call("POST", "auth/refresh", { body: { refreshToken: a.refreshToken } })).json.tokens;
    expect(a2.sessionId).toBe(a.sessionId);
    expect(a2.refreshToken).not.toBe(a.refreshToken);
    expect((await call("GET", "me", { token: a2.accessToken })).status).toBe(200);

    expect((await call("POST", "auth/refresh", { body: { refreshToken: a.refreshToken } })).status).toBe(401);
    expect((await call("POST", "auth/refresh", { body: { refreshToken: a2.refreshToken } })).status).toBe(401);
    expect((await call("GET", "me", { token: a2.accessToken })).status).toBe(401);
    expect((await call("GET", "me", { token: b.accessToken })).status).toBe(401);
  });

  it("signing out everywhere on the web, or being made inactive, ends app sessions too", async () => {
    const t = await login("regional@rayz.test");
    await m.db.db.update(S().staffAppTokens).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(S().staffAppTokens.id, t.sessionId));
    await m.db.db.update(S().staff).set({ sessionsValidAfter: new Date() }).where(eq(S().staff.id, ids.regional));
    expect((await call("GET", "me", { token: t.accessToken })).status).toBe(401);
    expect((await call("POST", "auth/refresh", { body: { refreshToken: t.refreshToken } })).status).toBe(401);
    await m.db.db.update(S().staff).set({ sessionsValidAfter: null }).where(eq(S().staff.id, ids.regional));

    const u = await login("regional@rayz.test");
    await m.db.db.update(S().staff).set({ active: false }).where(eq(S().staff.id, ids.regional));
    expect((await call("GET", "me", { token: u.accessToken })).status).toBe(401);
    expect((await call("POST", "auth/refresh", { body: { refreshToken: u.refreshToken } })).status).toBe(401);
    await m.db.db.update(S().staff).set({ active: true }).where(eq(S().staff.id, ids.regional));
  });

  it("a shop login signs in for the front-desk clock but has no personal schedule, clock or tips", async () => {
    const t = await login("coralville@rayz.test");
    const me = (await call("GET", "me", { token: t.accessToken })).json;
    expect(me.staff.kind).toBe("shop");
    expect(me.features).toMatchObject({ schedule: false, clock: false, tips: false, kiosk: true });
    for (const p of ["appointments", "schedule", "tips", "earnings", "banking", "devices"]) expect((await call("GET", p, { token: t.accessToken })).status, p).toBe(403);
    expect((await call("GET", "popups", { token: t.accessToken })).json.popups).toEqual([]);
  });
});

describe("appointments and client notes", () => {
  it("a barber sees their own appointments only; others' are not found unless they see every calendar", async () => {
    const t = await login("makenna@rayz.test");
    const c = await client("Privateson");
    const mine = await appt(c.id, ids.makenna);
    const theirs = await appt(c.id, ids.other);

    const list = await call("GET", `appointments?from=${today}&days=1`, { token: t.accessToken });
    expect(list.status).toBe(200);
    const got = list.json.appointments as { id: string; staffId: string; customer: { name: string } | null }[];
    expect(got.map((a) => a.id)).toContain(mine.id);
    expect(got.map((a) => a.id)).not.toContain(theirs.id);
    expect(got.every((a) => a.staffId === ids.makenna)).toBe(true);
    expect(got.find((a) => a.id === mine.id)!.customer!.name).not.toContain("Privateson");

    const one = await call("GET", `appointments/${mine.id}`, { token: t.accessToken });
    expect(one.json).toMatchObject({ id: mine.id, mine: true });
    expect((await call("GET", `appointments/${theirs.id}`, { token: t.accessToken })).status).toBe(404);
    expect((await call("GET", `appointments/${crypto.randomUUID()}`, { token: t.accessToken })).status).toBe(404);
    expect((await call("GET", `appointments?days=99`, { token: t.accessToken })).status).toBe(400);

    const fd = await login("frontdesk@rayz.test");
    expect((await call("GET", `appointments/${theirs.id}`, { token: fd.accessToken })).json).toMatchObject({ id: theirs.id, mine: false });
    const moline = await login("manager.moline@rayz.test");
    expect((await call("GET", `appointments/${theirs.id}`, { token: moline.accessToken })).status).toBe(404);

    const sched = await call("GET", `schedule?from=${today}&days=7`, { token: t.accessToken });
    expect(sched.status).toBe(200);
    expect(sched.json.days.every((d: { shopId: string }) => d.shopId === shop.coralville)).toBe(true);
  });

  it("client notes follow the permissions: no private manager notes for a barber, nothing without notes.view", async () => {
    const t = await login("makenna@rayz.test");
    const mgr = await login("michelle@rayz.test");
    const c = await client("Notesworth");
    const a = await appt(c.id, ids.makenna);
    const priv = await call("POST", `appointments/${a.id}/notes`, { token: mgr.accessToken, body: { kind: "private", body: "Asked for a refund last time" } });
    expect(priv.status, JSON.stringify(priv.json)).toBe(201);
    const cut = await call("POST", `appointments/${a.id}/notes`, { token: t.accessToken, body: { kind: "visit", body: "Low fade, #2 on the sides" } });
    expect(cut.status, JSON.stringify(cut.json)).toBe(201);
    expect((await call("POST", `appointments/${a.id}/notes`, { token: t.accessToken, body: { kind: "private", body: "nope" } })).status).toBe(403);

    const seen = await call("GET", `appointments/${a.id}/notes`, { token: t.accessToken });
    expect(seen.status).toBe(200);
    const bodies = JSON.stringify(seen.json.notes);
    expect(bodies).toContain("Low fade");
    expect(bodies).not.toContain("refund");
    expect(JSON.stringify((await call("GET", `appointments/${a.id}/notes`, { token: mgr.accessToken })).json.notes)).toContain("refund");
    const views = await m.db.db.select().from(S().clientAccessLog).where(m.drizzle.and(eq(S().clientAccessLog.customerId, c.id), eq(S().clientAccessLog.staffId, ids.makenna)));
    expect(views.some((v) => (v.detail as { via?: string } | null)?.via === "staff_app")).toBe(true);

    await setOverrides("makenna", { "notes.view": false });
    expect((await call("GET", `appointments/${a.id}/notes`, { token: t.accessToken })).status).toBe(403);
    await setOverrides("makenna", {});
  });
});

describe("pop-ups", () => {
  it("shows unseen congratulations until they're marked seen, and a clock-in reminder before the first client", async () => {
    const t = await login("makenna@rayz.test");
    const [ms] = await m.db.db
      .insert(S().staffMilestones)
      .values({ staffId: ids.makenna, kind: "count", metric: "services", threshold: 500, title: "500 cuts", achievedOn: today, shopId: shop.coralville, dedupeKey: `test:app:${ids.makenna}` })
      .returning();
    const first = (await call("GET", "popups", { token: t.accessToken })).json.popups as { id: string; kind: string }[];
    expect(first.find((p) => p.id === ms.id)?.kind).toBe("milestone");
    expect((await call("POST", "popups/seen", { token: t.accessToken, body: { ids: [ms.id] } })).json.seen).toBe(1);
    expect(((await call("GET", "popups", { token: t.accessToken })).json.popups as { id: string }[]).map((p) => p.id)).not.toContain(ms.id);

    const { popupsFor } = await import("@/server/staff-api/popups");
    const { requireStaffApp } = await import("@/server/staff-api/auth");
    const ctx = await requireStaffApp(new Request(`${BASE}/popups`, { headers: { authorization: `Bearer ${t.accessToken}` } }));
    const a = await appt((await client("Reminderly")).id, ids.makenna);
    const r = await popupsFor(ctx, new Date(a.startsAt.getTime() - 15 * 60_000));
    expect(r.popups.find((p) => p.kind === "clock_in_reminder")).toMatchObject({ shopId: shop.coralville });
    expect(r.popups.find((p) => p.kind === "clock_in_reminder")!.body).toMatch(/first client/);
  });
});

describe("the time clock", () => {
  it("punches from the phone with the front-desk QR code or the NFC sticker, with breaks; no proof, no punch", async () => {
    const { clockQrCode, clockProofUrl, nfcTagUrl } = await import("@/server/clock-codes");
    await m.db.db
      .update(S().shops)
      .set({ timeClock: { ...coralvilleClock, methods: ["qr", "nfc"] } })
      .where(eq(S().shops.id, shop.coralville));
    const t = await login("makenna@rayz.test");
    const over = await call("GET", "clock", { token: t.accessToken });
    expect(over.status).toBe(200);
    expect(over.json.state).toBe("off");
    expect(over.json.hasPin).toBe(true);
    expect(over.json.shops.find((s: { id: string }) => s.id === shop.coralville).methods).toEqual(["qr", "nfc"]);
    expect(JSON.stringify(over.json)).not.toMatch(/face|fingerprint|biometric/i);

    const none = await call("POST", "clock/punch", { token: t.accessToken, body: { shopId: shop.coralville, type: "in", confirmTimeOff: true } });
    expect(none.status).toBe(403);

    const scanned = await qrOf(clockProofUrl(shop.coralville, { qr: clockQrCode(shop.coralville).code }));
    expect(scanned.get("shop")).toBe(shop.coralville);
    const inn = await call("POST", "clock/punch", { token: t.accessToken, body: { shopId: scanned.get("shop"), type: "in", proof: { qr: scanned.get("qr") }, confirmTimeOff: true } });
    expect(inn.status, JSON.stringify(inn.json)).toBe(200);
    expect(inn.json).toMatchObject({ kind: "done", type: "in" });

    const tag = (await qrOf(await nfcTagUrl(shop.coralville))).get("tag")!;
    const brk = await call("POST", "clock/breaks/start", { token: t.accessToken, body: { proof: { tag }, plannedMin: 15 } });
    expect(brk.json).toMatchObject({ kind: "done", type: "break_start" });
    expect((await call("GET", "clock", { token: t.accessToken })).json.state).toBe("on_break");
    expect((await call("POST", "clock/breaks/end", { token: t.accessToken, body: { proof: { tag: "forged-tag-0000000000" } } })).status).toBe(403);
    expect((await call("POST", "clock/breaks/end", { token: t.accessToken, body: { proof: { tag } } })).json.type).toBe("break_end");
    expect((await call("POST", "clock/punch", { token: t.accessToken, body: { shopId: shop.coralville, type: "out", proof: { tag } } })).json.type).toBe("out");

    const punches = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, inn.json.punchId));
    expect(punches[0]).toMatchObject({ method: "qr", source: "self" });
  });

  it("the front-desk tablet punches anyone with their own PIN, once a manager registers it", async () => {
    const shopLogin = await login("coralville@rayz.test");
    const mgr = await login("michelle@rayz.test");
    expect((await call("POST", "clock/kiosk/register", { token: shopLogin.accessToken, body: { shopId: shop.coralville, label: "Front desk iPad" } })).status).toBe(403);
    expect((await call("GET", "clock/kiosk/team", { token: shopLogin.accessToken })).status).toBe(403);
    const reg = await call("POST", "clock/kiosk/register", { token: mgr.accessToken, body: { shopId: shop.coralville, label: "Front desk iPad" } });
    expect(reg.status, JSON.stringify(reg.json)).toBe(201);
    const device = { "x-clock-device": reg.json.token as string };

    const team = await call("GET", "clock/kiosk/team", { token: shopLogin.accessToken, headers: device });
    expect(team.json.team.map((p: { id: string }) => p.id)).toContain(ids.makenna);
    const qr = await call("GET", "clock/kiosk/qr", { token: shopLogin.accessToken, headers: device });
    expect(qr.json.url).toContain(`shop=${shop.coralville}`);

    expect((await call("POST", "clock/kiosk/status", { token: shopLogin.accessToken, headers: device, body: { staffId: ids.makenna, pin: "1357" } })).status).toBe(400);
    const st = await call("POST", "clock/kiosk/status", { token: shopLogin.accessToken, headers: device, body: { staffId: ids.makenna, pin: PIN } });
    expect(st.json).toMatchObject({ state: "off" });
    const inn = await call("POST", "clock/kiosk/punch", { token: shopLogin.accessToken, headers: device, body: { staffId: ids.makenna, pin: PIN, type: "in", confirmTimeOff: true } });
    expect(inn.json, JSON.stringify(inn.json)).toMatchObject({ kind: "done", type: "in" });
    expect((await call("POST", "clock/kiosk/punch", { token: shopLogin.accessToken, headers: device, body: { staffId: ids.makenna, pin: PIN, type: "out" } })).json.type).toBe("out");
    const [p] = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, inn.json.punchId));
    expect(p).toMatchObject({ method: "device", source: "kiosk" });

    const shopPunch = await call("POST", "clock/punch", { token: shopLogin.accessToken, body: { shopId: shop.coralville, type: "in" } });
    expect(shopPunch.status).toBe(403);
    expect((await call("PUT", "clock/pin", { token: (await login("makenna@rayz.test")).accessToken, body: { pin: "1234" } })).status).toBe(400);
  });
});

describe("tips, earnings, payouts and banking", () => {
  it("shows their own tips and payouts, and earnings only in the parts their permissions allow", async () => {
    const t = await login("makenna@rayz.test");
    const tips = await call("GET", "tips?days=14", { token: t.accessToken });
    expect(tips.status).toBe(200);
    expect(tips.json.shops.map((s: { shopId: string }) => s.shopId)).toContain(shop.coralville);
    expect((await call("GET", "payouts", { token: t.accessToken })).json.payouts).toBeInstanceOf(Array);

    const all = await call("GET", "earnings", { token: t.accessToken });
    expect(all.status).toBe(200);
    expect(all.json.sees).toMatchObject({ sales: true, tips: true });
    expect(all.json.days).toHaveLength(7);
    expect(typeof all.json.totals.serviceNetCents).toBe("number");

    await setOverrides("makenna", { "reports.money": false });
    const noMoney = (await call("GET", "earnings", { token: t.accessToken })).json;
    expect(noMoney.sees.sales).toBe(false);
    expect(noMoney.totals.serviceNetCents).toBeNull();
    expect(noMoney.days.every((d: { serviceNetCents: number | null }) => d.serviceNetCents === null)).toBe(true);

    await setOverrides("makenna", { "reports.money": false, "tips.own": false, "compensation.own": false });
    expect((await call("GET", "earnings", { token: t.accessToken })).status).toBe(403);
    expect((await call("GET", "tips", { token: t.accessToken })).status).toBe(403);
    expect((await call("POST", "banking/onboarding-link", { token: t.accessToken })).status).toBe(403);
    await setOverrides("makenna", {});
    expect((await call("GET", "earnings?from=2026-01-01&to=2026-12-31", { token: t.accessToken })).status).toBe(400);
  });

  it("with direct Stripe payouts switched off (FEATURE_STAFF_STRIPE_PAYOUTS=false), every banking route is refused and tips go through payroll", async () => {
    process.env.FEATURE_STAFF_STRIPE_PAYOUTS = "false";
    onTestFinished(() => void delete process.env.FEATURE_STAFF_STRIPE_PAYOUTS);
    const t = await login("makenna@rayz.test");
    expect((await call("GET", "me", { token: t.accessToken })).json.features.banking).toBe(false);
    for (const [method, p] of [
      ["GET", "banking"],
      ["GET", "banking/external-accounts"],
      ["POST", "banking/onboarding-link"],
      ["POST", "banking/dashboard-link"],
    ] as const) {
      const r = await call(method, p, { token: t.accessToken });
      expect(r.status, p).toBe(403);
      expect(r.json.error.details).toMatchObject({ feature: "staff_stripe_payouts", enabled: false });
    }
    expect((await call("PUT", "banking/method", { token: t.accessToken, body: { method: "stripe", instant: true } })).status).toBe(403);
  });

  it("sets up their own debit card or bank through Stripe's page (on by default), keeping the account id, status and last 4 only", async () => {
    const t = await login("makenna@rayz.test");
    expect((await call("GET", "me", { token: t.accessToken })).json.features.banking).toBe(true);
    await m.db.db.delete(S().staffPayoutAccounts).where(eq(S().staffPayoutAccounts.staffId, ids.makenna));
    const before = (await call("GET", "banking", { token: t.accessToken })).json;
    expect(before.simulator).toBe(true);
    expect(before.onboarding).toEqual({ step: "start", label: "Set up Stripe payouts" });
    expect((await call("GET", "banking/external-accounts", { token: t.accessToken })).json).toMatchObject({ status: "not_set_up", externalAccounts: [] });
    const link = await call("POST", "banking/onboarding-link", { token: t.accessToken });
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.json.url).toBeNull();
    expect(link.json.step).toBe("start");
    const b = link.json.banking;
    expect(b.stripeAccountId).toBeTruthy();
    expect(b.onboarding.step).toBe("done");
    expect(b.requirements).toMatchObject({ due: [], pending: [], detailsSubmitted: true, payoutsEnabled: true });
    expect(b.instant).toMatchObject({ allowed: true, eligible: true, to: { type: "card", last4: "5556" }, feePaidBy: "employee", fee: { pct: 1.5, minCents: 50 } });
    expect(b.destination.last4).toMatch(/^\d{4}$/);
    expect(Object.keys(b.destination).sort()).toEqual(["label", "last4", "name", "type"]);
    expect(JSON.stringify({ ...b, stripeAccountId: null, shops: null })).not.toMatch(/routing|account_number|\d{8,}/);

    const changed = await call("POST", "banking/dashboard-link", { token: t.accessToken });
    expect(changed.json.banking.destination.last4).not.toBe(b.destination.last4);
    const list = await call("GET", "banking/external-accounts", { token: t.accessToken });
    expect(list.status).toBe(200);
    expect(list.json.externalAccounts).toEqual([
      { id: "sim_ba_6789", type: "bank_account", name: "STRIPE TEST BANK", last4: "6789", label: "STRIPE TEST BANK ••6789", default: true, instant: false, instantDestination: false },
      { id: "sim_card_5556", type: "card", name: "Visa", last4: "5556", label: "Visa card ••5556", default: false, instant: true, instantDestination: true },
    ]);
    expect((await call("GET", "banking", { token: t.accessToken })).json.instant.to).toMatchObject({ type: "card", last4: "5556" });

    await m.db.db.update(S().staffPayoutAccounts).set({ requirementsDue: ["individual.verification.document"] }).where(eq(S().staffPayoutAccounts.staffId, ids.makenna));
    const due = (await call("GET", "banking", { token: t.accessToken })).json;
    expect(due.onboarding.step).toBe("update");
    expect(due.requirements.due).toEqual([{ key: "individual.verification.document", label: "A photo of your ID" }]);
    await m.db.db.update(S().staffPayoutAccounts).set({ detailsSubmitted: false, payoutsEnabled: false, requirementsDue: [] }).where(eq(S().staffPayoutAccounts.staffId, ids.makenna));
    expect((await call("GET", "banking", { token: t.accessToken })).json.onboarding.step).toBe("resume");
    expect((await call("POST", "banking/onboarding-link", { token: t.accessToken })).json.step).toBe("resume");

    const [row] = await m.db.db.select().from(S().staffPayoutAccounts).where(eq(S().staffPayoutAccounts.staffId, ids.makenna));
    const stored = Object.values(row).filter((v) => typeof v === "string") as string[];
    expect(stored.some((v) => /^\d{8,}$/.test(v))).toBe(false);
  });
});

describe("push for their own bookings", () => {
  it("the first phone turns on booking pushes; new and cancelled bookings push to it until it signs out", async () => {
    const t = await login("makenna@rayz.test");
    await m.db.db.update(S().staff).set({ notificationPrefs: {} }).where(eq(S().staff.id, ids.makenna));
    expect((await call("POST", "devices", { token: t.accessToken, body: { platform: "ios", provider: "fcm", token: "apns-token-wrong" } })).status).toBe(400);
    const dev = await call("POST", "devices", { token: t.accessToken, body: { platform: "ios", provider: "apns", token: "a1b2c3d4e5f6a7b8", appVersion: "1.0.0" } });
    expect(dev.status, JSON.stringify(dev.json)).toBe(201);
    expect(dev.json.bookingPushTurnedOn).toBe(true);
    const prefs = (await call("GET", "me/notifications", { token: t.accessToken })).json;
    expect(prefs.prefs.events.confirm).toEqual(["push"]);
    expect(prefs.devices.map((d: { id: string }) => d.id)).toEqual([dev.json.id]);

    const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
    let booked: Awaited<ReturnType<Mods["booking"]["createAppointment"]>> | null = null;
    for (let i = 3; i < 30 && !booked; i++) {
      const a = await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId: svc.id, barberRef: ids.makenna });
      if (a.slots.length) booked = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: ids.makenna, startsAt: a.slots[0].startsAt, customer: { firstName: "Pushy", phone: "3195559188" }, source: "online", actor });
    }
    const jobs = async (id: string) => m.db.db.select().from(S().notificationJobs).where(m.drizzle.and(eq(S().notificationJobs.appointmentId, id), eq(S().notificationJobs.channel, "push")));
    expect((await jobs(booked!.id)).map((j) => [j.kind, j.to])).toEqual([["staff_confirm", dev.json.id]]);
    await m.booking.cancelAppointment(booked!.code, { actor, byCustomer: false });
    expect((await jobs(booked!.id)).map((j) => j.kind).sort()).toEqual(["staff_cancel", "staff_confirm"]);

    expect((await call("POST", "auth/logout", { body: { refreshToken: t.refreshToken } })).status).toBe(204);
    expect((await call("GET", "me", { token: t.accessToken })).status).toBe(401);
    const [d] = await m.db.db.select().from(S().staffDevices).where(eq(S().staffDevices.id, dev.json.id));
    expect(d.revokedAt).toBeInstanceOf(Date);
    const { queueStaffAlert } = await import("@/server/staff-alerts");
    const queued = await queueStaffAlert("reschedule", booked!.id);
    const after = await jobs(booked!.id);
    expect(after.filter((j) => j.kind === "staff_reschedule")).toHaveLength(0);
    expect(queued).toBe(0);
  });
});
