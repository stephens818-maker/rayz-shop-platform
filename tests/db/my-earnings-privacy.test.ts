/**
 * My Earnings privacy (claude bot's corrections, 2026-10-28), against a real database: the employee
 * is the token's only; staff MFA on the session before any figure; every view in the audit log;
 * nothing cached; client first names only; and the tenant and IDOR side with a barber at two shops
 * (their Chicago workweek's hours added up across both) and shops gated by the rollout pilot, where
 * a second-wave shop's figures come from its Squire report.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
let today = "";
const shop: Record<string, string> = {};
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const sales: Record<string, string[]> = { barber2: [], makenna: [] };
const PASSWORD = process.env.SEED_PASSWORD ?? "rayz2026!";
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const call = (...a: Parameters<typeof api.call>) => api.call(...a);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const cash = { method: "cash" as const, cashTenderedCents: null };
/** Tip amounts only one of them got, to look for in the other's answers. */
const ONLY = { barber2: [4111, 4222], makenna: [1919] };
const SQUIRE_TIPS = { barber2: 333.33, makenna: 444.44 };

const ENDPOINTS = (periodId: string, date: string) => [
  "me/pay-periods",
  `me/earnings?periodId=${periodId}`,
  `me/earnings/days?periodId=${periodId}`,
  `me/earnings/tickets?periodId=${periodId}&date=${date}`,
  `me/payouts?periodId=${periodId}`,
  "me/earnings/ytd",
];

async function sale(shopId: string, staffId: string, tipCents: number, client?: { first: string; last: string }) {
  const sl = await m.checkout.openBlankSale(shopId, actor, staffId);
  if (client) {
    const [c] = await m.db.db.insert(s().customers).values({ firstName: client.first, lastName: client.last, phone: `+1319555${String(Math.floor(Math.random() * 9000) + 1000)}` }).returning();
    await m.db.db.update(s().sales).set({ customerId: c.id }).where(eq(s().sales.id, sl.id));
  }
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sl.id, lines: [{ kind: "service" as const, refId: svc.id, qty: 1 }], tipCents, tender: cash, actor });
  return sl.id;
}

function numbersIn(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number") out.push(x);
  else if (Array.isArray(x)) for (const v of x) numbersIn(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) numbersIn(v, out);
  return out;
}

function expectNothingOf(who: "barber2" | "makenna", r: { text: string; json: unknown }, where: string) {
  for (const id of [ids[who], ...sales[who]]) expect(r.text, `${where}: ${id}`).not.toContain(id);
  const nums = new Set(numbersIn(r.json));
  for (const a of [...ONLY[who], Math.round(SQUIRE_TIPS[who] * 100)]) expect(nums.has(a), `${where}: ${a}`).toBe(false);
}

const get = async (p: string, who = "barber2") => {
  const r = await call("GET", p, { token: tokens[who] });
  expect(r.status, `${p} ${r.text}`).toBe(200);
  return r.json as J;
};

let cur: { start: string; end: string } = { start: "", end: "" };
let prev: { start: string; end: string } = { start: "", end: "" };

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  today = m.time.todayLocal();
  const { addTestPlanLogins } = await import("../../scripts/test-plan-logins");
  await addTestPlanLogins(m.db.db, PASSWORD);
  for (const x of await m.db.db.select().from(s().shops)) shop[x.slug] = x.id;
  for (const [k, email] of [
    ["barber2", "barber2.test@rayz.test"],
    ["makenna", "makenna@rayz.test"],
    ["michelle", "michelle@rayz.test"],
  ] as const)
    ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, email) }))!.id;
  await m.db.db.update(s().staff).set({ squireName: "Barber Two" }).where(eq(s().staff.id, ids.barber2));
  await m.db.db.update(s().staff).set({ squireName: "Makenna Coral" }).where(eq(s().staff.id, ids.makenna));

  const { ensurePayGroups } = await import("@/server/payroll/run");
  const { periodOf } = await import("@/domain/payroll/calendar");
  const cal = (await ensurePayGroups()).find((g) => g.shopId === shop.coralville)!.calendar;
  cur = periodOf(cal, today);
  prev = periodOf(cal, m.time.addDays(cur.start, -1));

  // A full week at Moline and Saturday at Coralville, the same employer: 46 hours, 6 of them overtime.
  const { weekStartOf } = await import("@/domain/payroll/overtime");
  const sunday = weekStartOf(m.time.addDays(prev.start, 1));
  const at = (d: string, startMin: number, mins: number) => ({ startsAt: m.time.zonedWallTime(d, startMin).toJSDate(), endsAt: m.time.zonedWallTime(d, startMin + mins).toJSDate() });
  for (let i = 1; i <= 5; i++) await m.db.db.insert(s().timeEntries).values({ staffId: ids.barber2, shopId: shop.moline, ...at(m.time.addDays(sunday, i), 540, 480), source: "manual" });
  await m.db.db.insert(s().timeEntries).values({ staffId: ids.barber2, shopId: shop.coralville, ...at(m.time.addDays(sunday, 6), 540, 360), source: "manual" });

  sales.barber2.push(await sale(shop.coralville, ids.barber2, 4111, { first: "Odalys Maria", last: "Quintanilla-Smythe" }), await sale(shop.moline, ids.barber2, 4222));
  sales.makenna.push(await sale(shop.coralville, ids.makenna, 1919, { first: "Benedikt", last: "Vanderwaal" }));

  for (const [k, email] of [
    ["barber2", "barber2.test@rayz.test"],
    ["makenna", "makenna@rayz.test"],
    ["michelle", "michelle@rayz.test"],
  ] as const)
    tokens[k] = (await api.login(email)).accessToken;
}, 240_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await m?.db.closeDb();
});

describe("a barber at two shops sees only their own, both shops together", () => {
  it("each Chicago workweek adds up their hours at both shops, with each shop's part, and the overtime is labelled an estimate", async () => {
    await m.db.db.update(s().staff).set({ permissionOverrides: { "compensation.own": true } }).where(eq(s().staff.id, ids.barber2));
    onTestFinished(async () => void (await m.db.db.update(s().staff).set({ permissionOverrides: {} }).where(eq(s().staff.id, ids.barber2))));
    const e = await get(`me/earnings?periodId=${prev.start}`);
    expect((e.shops as J[]).map((x) => x.shopId).sort()).toEqual([shop.moline, shop.coralville].sort());
    const { weekStartOf } = await import("@/domain/payroll/overtime");
    const w = (e.workweeks as J[]).find((x) => x.weekStart === weekStartOf(m.time.addDays(prev.start, 1)))!;
    expect(w).toMatchObject({ timezone: "America/Chicago", productionHours: 46, otHours: 6, regularHours: 40, otIsEstimate: true, otLabelCode: expect.stringMatching(/ot_estimated|partial_week/) });
    const part = (id: string) => (w.shops as J[]).find((x) => x.shopId === id);
    expect(part(shop.moline)).toMatchObject({ productionHours: 40 });
    expect(part(shop.coralville)).toMatchObject({ productionHours: 6 });
    expect(part(shop.moline).otHours + part(shop.coralville).otHours).toBe(6);
    expect(e).toMatchObject({ otIsEstimate: true, otDisclosure: expect.stringMatching(/^Estimated/) });
  });

  it("tickets at either shop of the period, clients by first name only; never the other barber's", async () => {
    const t = await get(`me/earnings/tickets?periodId=current&date=${today}`);
    expect((t.tickets as J[]).map((x) => x.saleId).sort()).toEqual([...sales.barber2].sort());
    const named = (t.tickets as J[]).find((x) => x.saleId === sales.barber2[0]);
    expect(named.clientFirstName).toBe("Odalys");
    expect(t.text ?? JSON.stringify(t)).not.toMatch(/Maria|Quintanilla|Smythe/);
    expect((t.tickets as J[]).find((x) => x.saleId === sales.barber2[1]).clientFirstName).toBe("Walk-in");
    const mk = await call("GET", `me/earnings/tickets?periodId=current&date=${today}`, { token: tokens.makenna });
    expect(mk.text).not.toMatch(/Vanderwaal/);
    expect(mk.json.tickets.find((x: J) => x.saleId === sales.makenna[0]).clientFirstName).toBe("Benedikt");
  });

  it("neither the two-shop barber nor a coworker at one of their shops, nor that shop's manager, sees the other's figures on any endpoint", async () => {
    for (const p of ENDPOINTS("current", today)) {
      expectNothingOf("makenna", await call("GET", p, { token: tokens.barber2 }), `barber2 ${p}`);
      expectNothingOf("barber2", await call("GET", p, { token: tokens.makenna }), `makenna ${p}`);
      expectNothingOf("barber2", await call("GET", p, { token: tokens.michelle }), `michelle ${p}`);
    }
  });

  it("X-Shop-Id for a shop they don't work at is refused, and their own shop doesn't widen anything", async () => {
    for (const p of ENDPOINTS("current", today)) {
      const r = await call("GET", p, { token: tokens.barber2, shop: shop.kimberly });
      expect(r.status, `${p} ${r.text}`).toBe(403);
      expectNothingOf("makenna", r, p);
      const own = await call("GET", p, { token: tokens.barber2, shop: shop.coralville });
      expect(own.status, `${p} ${own.text}`).toBe(200);
      expectNothingOf("makenna", own, p);
    }
  });

  it("any staff id is 400 and other employees' ids are 404, never theirs", async () => {
    for (const p of ENDPOINTS("current", today))
      for (const k of ["staffId", "employeeId", "staff_id"]) {
        const r = await call("GET", `${p}${p.includes("?") ? "&" : "?"}${k}=${ids.makenna}`, { token: tokens.barber2 });
        expect(r.status, `${p} ${k}`).toBe(400);
        expect(r.headers.get("cache-control")).toBe("private, no-store");
        expectNothingOf("makenna", r, p);
      }
    for (const p of [`me/earnings?periodId=${ids.makenna}`, `me/earnings/tickets?periodId=current&date=${sales.makenna[0]}`]) expect((await call("GET", p, { token: tokens.barber2 })).status, p).toBe(400);

    // Records of Makenna's that do take an id: her pay question, her session.
    const q = await call("POST", "me/pay-questions", { token: tokens.makenna, body: { shopId: shop.coralville, periodStart: cur.start, topic: "hours", detail: "Saturday looks short" } });
    expect(q.status, q.text).toBe(201);
    const theirs = q.json.id ?? q.json.question?.id;
    for (const [method, p, body] of [
      ["POST", `me/pay-questions/${theirs}/escalate`, { note: "x" }],
      ["POST", `me/pay-questions/${theirs}/resolve`, undefined],
    ] as const) {
      const r = await call(method, p, { token: tokens.barber2, body });
      expect(r.status, `${p} ${r.text}`).toBe(404);
      expect(r.text).not.toMatch(/Saturday looks short/);
    }
    const [session] = await m.db.db.select({ id: s().staffAppTokens.sessionId }).from(s().staffAppTokens).where(eq(s().staffAppTokens.staffId, ids.makenna)).limit(1);
    expect((await call("DELETE", `me/sessions/${session.id}`, { token: tokens.barber2 })).status).toBe(404);
    expect((await call("GET", `timecards/${ids.makenna}?period=${today}`, { token: tokens.barber2 })).status).toBe(403);
  });
});

describe("every view is in the audit log, and nothing is cached", () => {
  it("one staff.earnings_view per answer: the endpoint, the period asked for and the session; a refused request isn't a view", async () => {
    const views = () => m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "staff.earnings_view"), eq(s().auditLog.entityId, ids.barber2)));
    const before = new Set((await views()).map((x) => x.id));
    for (const p of ENDPOINTS(cur.start, today)) {
      const r = await call("GET", p, { token: tokens.barber2 });
      expect(r.status, p).toBe(200);
      expect(r.headers.get("cache-control"), p).toBe("private, no-store");
      expect(r.headers.get("x-staff-cache"), p).toBe("none");
    }
    await call("GET", `me/earnings?periodId=${cur.start}&staffId=${ids.makenna}`, { token: tokens.barber2 });
    const fresh = (await views()).filter((x) => !before.has(x.id)) as J[];
    expect(fresh).toHaveLength(6);
    expect(fresh.map((x) => x.details.endpoint).sort()).toEqual(["me/earnings", "me/earnings/days", "me/earnings/tickets", "me/earnings/ytd", "me/pay-periods", "me/payouts"]);
    for (const x of fresh) expect(x.details).toMatchObject({ via: "staff_app", sessionId: expect.any(String) });
    expect(fresh.find((x) => x.details.endpoint === "me/earnings/tickets").details).toMatchObject({ periodId: cur.start, date: today });
    for (const x of fresh) expect(x.actorStaffId).toBe(ids.barber2);
  });
});

describe("staff MFA on the session (ENFORCE_STAFF_MFA=1)", () => {
  let secret = "";
  const code = async (staffId: string) => {
    const totp = await import("@/lib/totp");
    await m.db.db.update(s().staff).set({ totpLastStep: null }).where(eq(s().staff.id, staffId));
    return totp.totpCode(secret);
  };

  beforeAll(() => {
    vi.stubEnv("ENFORCE_STAFF_MFA", "1");
  });

  it("a password-only session gets 403 mfaRequired enroll on every endpoint, uncached, and no view is logged", async () => {
    const before = (await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "staff.earnings_view"))).length;
    for (const p of ENDPOINTS("current", today)) {
      const r = await call("GET", p, { token: tokens.barber2 });
      expect(r.status, `${p} ${r.text}`).toBe(403);
      expect(r.json.error.details).toMatchObject({ mfaRequired: "enroll" });
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expectNothingOf("barber2", r, p);
    }
    expect((await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "staff.earnings_view"))).length).toBe(before);
  });

  it("a password step-up isn't MFA; setting up an authenticator in the app is, and then every sign-in asks for the code", async () => {
    expect((await call("POST", "me/step-up", { token: tokens.barber2, body: { password: PASSWORD } })).status).toBe(200);
    expect((await call("GET", "me/earnings?period=current", { token: tokens.barber2 })).json.error.details).toMatchObject({ mfaRequired: "enroll" });

    const setup = await call("POST", "me/two-factor/setup", { token: tokens.barber2 });
    expect(setup.status, setup.text).toBe(200);
    expect(setup.json).toMatchObject({ ticket: expect.any(String), enroll: { qr: expect.stringMatching(/^data:image\/png/), secret: expect.any(String) } });
    secret = setup.json.enroll.secret.replace(/\s/g, "");

    // The setup ticket isn't a sign-in ticket, nor good on another of their sessions.
    expect((await call("POST", "auth/login/code", { body: { ticket: setup.json.ticket, code: await code(ids.barber2) } })).status).toBe(401);
    const other = (await api.login("barber2.test@rayz.test")).accessToken;
    expect((await call("POST", "me/two-factor/verify", { token: other, body: { ticket: setup.json.ticket, code: await code(ids.barber2) } })).status).toBe(401);
    expect((await call("POST", "me/two-factor/verify", { token: tokens.barber2, body: { ticket: setup.json.ticket, code: "000000" } })).status).toBe(401);

    const ok = await call("POST", "me/two-factor/verify", { token: tokens.barber2, body: { ticket: setup.json.ticket, code: await code(ids.barber2) } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ twoStep: true, mfaAt: expect.any(String) });
    expect((await call("GET", "me/earnings?period=current", { token: tokens.barber2 })).status).toBe(200);
    const [logged] = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "user.two_factor_setup"), eq(s().auditLog.entityId, ids.barber2)));
    expect(logged.details).toMatchObject({ via: "staff_app" });

    // Their other session signed in with a password before: it now needs the code (step-up), not setup.
    const stale = await call("GET", "me/earnings?period=current", { token: other });
    expect(stale.json.error.details).toMatchObject({ mfaRequired: "code" });
    expect((await call("POST", "me/two-factor/setup", { token: other })).status).toBe(409);
    expect((await call("POST", "me/step-up", { token: other, body: { code: await code(ids.barber2) } })).status).toBe(200);
    expect((await call("GET", "me/earnings?period=current", { token: other })).status).toBe(200);

    // A new sign-in: password, then the code; that session counts from the start.
    const first = await call("POST", "auth/login", { body: { email: "barber2.test@rayz.test", password: PASSWORD, deviceName: "Test phone" } });
    expect(first.json.twoFactor?.ticket, first.text).toBeTruthy();
    const second = await call("POST", "auth/login/code", { body: { ticket: first.json.twoFactor.ticket, code: await code(ids.barber2), deviceName: "Test phone" } });
    expect(second.status, second.text).toBe(200);
    for (const p of ENDPOINTS("current", today)) expect((await call("GET", p, { token: second.json.accessToken ?? second.json.tokens?.accessToken })).status, p).toBe(200);
  });

  it("setting up needs a sign-in or step-up in the last 15 minutes on that session", async () => {
    const t = await api.login("makenna@rayz.test");
    const old = new Date(Date.now() - 60 * 60_000);
    await m.db.db.update(s().staffAppTokens).set({ createdAt: old, stepUpAt: null }).where(eq(s().staffAppTokens.sessionId, t.sessionId));
    const r = await call("POST", "me/two-factor/setup", { token: t.accessToken });
    expect(r.status, r.text).toBe(403);
    expect(r.json.error.details).toMatchObject({ stepUpRequired: "two_factor" });
  });

  it("without the switch (the sandbox demo and the test suite by default) My Earnings doesn't ask", async () => {
    vi.stubEnv("ENFORCE_STAFF_MFA", "");
    expect((await call("GET", "me/earnings?period=current", { token: tokens.makenna })).status).toBe(200);
    vi.stubEnv("ENFORCE_STAFF_MFA", "1");
    expect((await call("GET", "me/earnings?period=current", { token: tokens.makenna })).json.error.details).toMatchObject({ mfaRequired: "enroll" });
    vi.stubEnv("ENFORCE_STAFF_MFA", "");
  });
});

describe("shops gated by the rollout pilot", () => {
  it("the pilot's figures come from here and a second-wave shop's from its Squire report; each barber sees only their own row of it", async () => {
    const rollout = await import("@/server/rollout");
    await rollout.savePlan(actor, shop.moline, { wave: 1, plannedOn: cur.start, payrollFrom: cur.start, squireBackupUntil: null, note: "Pilot" });
    const HEAD = "Name,Hours Worked,Personnel ID,Card,Cash,GC Used,GC Bought,Card Fees (on Total),Commission Splits Fee,Total,Commission %,Due to Barbers,Squire Tips,POS Tips,Gift Card Tips,Tips,Total to Barber,Tax,Due to Shop";
    const line = (name: string, hours: number, total: number, tips: number) => `${name},${hours.toFixed(2)},,0,0,0,0,0,0,"$${total.toFixed(2)}",0%,0,0,0,0,"$${tips.toFixed(2)}",0,"$0.00",0`;
    const r = await rollout.importSquireReport(actor, shop.coralville, cur.start, { name: "coralville.csv", text: [HEAD, line("Barber Two", 12, 600, SQUIRE_TIPS.barber2), line("Makenna Coral", 20, 900, SQUIRE_TIPS.makenna)].join("\n") });
    expect(r).toMatchObject({ rows: 2 });

    const b2 = await get("me/earnings?period=current");
    const part = (e: J, id: string) => (e.shops as J[]).find((x) => x.shopId === id);
    expect(part(b2, shop.moline)).toMatchObject({ source: "platform", squireImported: false });
    expect(part(b2, shop.coralville)).toMatchObject({ source: "squire", squireImported: true });
    expect(part(b2, shop.moline).tipToBarber).toBe(true);
    expect(numbersIn(b2)).not.toContain(Math.round(SQUIRE_TIPS.makenna * 100));
    const mk = await get("me/earnings?period=current", "makenna");
    expect(part(mk, shop.coralville)).toMatchObject({ source: "squire", squireImported: true });
    expect(numbersIn(mk)).not.toContain(Math.round(SQUIRE_TIPS.barber2 * 100));
    for (const p of ENDPOINTS("current", today)) {
      expectNothingOf("makenna", await call("GET", p, { token: tokens.barber2 }), `pilot barber2 ${p}`);
      expectNothingOf("barber2", await call("GET", p, { token: tokens.makenna }), `pilot makenna ${p}`);
      expectNothingOf("barber2", await call("GET", p, { token: tokens.michelle }), `pilot michelle ${p}`);
    }

    // The tip switch on at the pilot only: a second-wave shop's card tips are paid through payroll.
    await m.db.db.update(s().shops).set({ tipToBarber: false }).where(m.drizzle.ne(s().shops.id, shop.moline));
    const gated = await get("me/payouts?period=current");
    const sw = (id: string) => (gated.shops as J[]).find((x) => x.shopId === id);
    expect(sw(shop.moline)).toMatchObject({ tipToBarber: true });
    expect(sw(shop.coralville)).toMatchObject({ tipToBarber: false, tipTransfersEnabled: false, payrollCopy: expect.stringMatching(/./) });
  });
});
