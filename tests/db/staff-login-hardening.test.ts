/**
 * Staff sign-in hardening (ST-C0c) against a real database: wrong passwords lock the account and
 * every answer reads the same; privileged roles must set up two-step sign-in; each browser is its
 * own session that can be signed out; reveal, export and refund need a sign-in or step-up in the
 * last 15 minutes, web and staff app; a new browser or phone emails them; and a front-desk clock is
 * paired by a manager's one-time code and runs with no staff session, its app token bound to the
 * install that paired it.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { jar, signInAs, staleStepUp } from "./session";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const PASSWORD = process.env.SEED_PASSWORD ?? "rayz2026!";

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const withEnv = (k: string, v: string) => {
  const before = process.env[k];
  process.env[k] = v;
  onTestFinished(() => {
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  });
};

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  for (const k of ["owner", "michelle", "makenna", "kat", "frontdesk", "manager.moline"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(S().shops)) shop[s.slug] = s.id;
  const [c] = await m.db.db.insert(S().customers).values({ firstName: "Lena", lastName: "Stepwise", birthday: "1990-04-02", homeShopId: shop.coralville }).returning();
  ids.client = c.id;
}, 240_000);

afterAll(async () => {
  await signInAs(null);
  jar.device = undefined;
});

describe("wrong passwords", () => {
  it("lock the account on the 10th in a row, and the lock reads like a rate limit", async () => {
    const { checkPassword } = await import("@/server/auth/sign-in-guard");
    const email = "kat@rayz.test";
    for (let i = 0; i < 9; i++) await expect(checkPassword(email, "not it", { ip: null, via: "web" })).rejects.toThrow("Email or password is incorrect");
    await expect(checkPassword(email, "still not it", { ip: null, via: "app" })).rejects.toThrow("Email or password is incorrect");
    const row = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.id, ids.kat) }))!;
    expect(row.passwordFailures).toBe(10);
    expect(row.passwordLockedUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    // Locked: the right password is refused too, with the same words as too many tries.
    await expect(checkPassword(email, PASSWORD, { ip: null, via: "app" })).rejects.toThrow(/Too many sign-in attempts/);
    await m.db.db.update(S().staff).set({ passwordLockedUntil: new Date(Date.now() - 1000) }).where(eq(S().staff.id, ids.kat));
    expect((await checkPassword(email, PASSWORD, { ip: null, via: "app" })).id).toBe(ids.kat);
    expect((await m.db.db.query.staff.findFirst({ where: eq(S().staff.id, ids.kat) }))!).toMatchObject({ passwordFailures: 0, passwordLockedUntil: null });
  });

  it("an unknown email is refused in the same words", async () => {
    const { checkPassword } = await import("@/server/auth/sign-in-guard");
    await expect(checkPassword("nobody-here@rayz.test", PASSWORD, { ip: null, via: "web" })).rejects.toThrow("Email or password is incorrect");
  });

  it("an address is limited across emails", async () => {
    const { checkPassword } = await import("@/server/auth/sign-in-guard");
    const ip = "203.0.113.77";
    for (let i = 0; i < 30; i++) await checkPassword(`ghost${i}@rayz.test`, "x", { ip, via: "web" }).catch(() => null);
    await expect(checkPassword("owner@rayz.test", PASSWORD, { ip, via: "web" })).rejects.toThrow(/Too many sign-in attempts/);
  });
});

describe("two-step sign-in for privileged roles", () => {
  it("the owner and a shop manager must set it up; a barber and the front desk needn't", async () => {
    withEnv("ENFORCE_STAFF_MFA", "1");
    const { signInFactorFor } = await import("@/server/auth/sign-in-guard");
    const row = async (k: string) => (await m.db.db.query.staff.findFirst({ where: eq(S().staff.id, ids[k]) }))!;
    expect(await signInFactorFor(await row("owner"))).toBe("enroll");
    expect(await signInFactorFor(await row("michelle"))).toBe("enroll");
    expect(await signInFactorFor(await row("makenna"))).toBeNull();
    expect(await signInFactorFor(await row("frontdesk"))).toBeNull();
  });

  it("the staff app gives the owner the authenticator setup, not tokens", async () => {
    withEnv("ENFORCE_STAFF_MFA", "1");
    const r = await api.call("POST", "auth/login", { body: { email: "owner@rayz.test", password: PASSWORD, deviceName: "Test phone" } });
    expect(r.status).toBe(200);
    expect(r.json.tokens).toBeUndefined();
    expect(r.json.twoFactor).toMatchObject({ ticket: expect.any(String), enroll: expect.anything() });
    const barber = await api.call("POST", "auth/login", { body: { email: "makenna@rayz.test", password: PASSWORD, deviceName: "Test phone" } });
    expect(barber.json.tokens).toBeDefined();
  });
});

describe("web sessions", () => {
  it("each browser is its own session; signing one out ends it at once", async () => {
    const { getStaffContext } = await import("@/server/auth/staff");
    const { myWebSessions } = await import("@/server/auth/sessions");
    const { endMyWebSessionAction, endOtherWebSessionsAction } = await import("@/app/admin/my-security/actions");
    jar.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    await signInAs(ids.makenna);
    const first = jar.sid!;
    await signInAs(ids.makenna);
    const second = jar.sid!;
    expect((await getStaffContext())?.session).toEqual({ kind: "web", id: second });
    const list = await myWebSessions(ids.makenna, second);
    expect(list.filter((s) => [first, second].includes(s.id))).toHaveLength(2);
    expect(list.find((s) => s.id === second)).toMatchObject({ device: "Safari on macOS", current: true });
    expect(await endMyWebSessionAction(first)).toEqual({ ok: true, data: null });
    expect((await myWebSessions(ids.makenna, second)).map((s) => s.id)).not.toContain(first);
    // Someone else's session isn't theirs to end.
    await signInAs(ids.kat);
    const kats = jar.sid!;
    await signInAs(ids.makenna);
    expect(await endMyWebSessionAction(kats)).toMatchObject({ ok: false });
    expect(await endOtherWebSessionsAction()).toMatchObject({ ok: true });
    expect((await myWebSessions(ids.makenna, jar.sid!)).map((s) => s.id)).toEqual([jar.sid]);
    jar.userAgent = undefined;
  });

  it("a cookie without a session, or for one signed out, is no session", async () => {
    const { getStaffContext } = await import("@/server/auth/staff");
    const { signToken } = await import("@/server/auth/tokens");
    const { endWebSession } = await import("@/server/auth/sessions");
    jar.token = await signToken({ sub: ids.makenna }, "staff_session", 600);
    expect(await getStaffContext()).toBeNull();
    await signInAs(ids.makenna);
    await endWebSession(ids.makenna, jar.sid!);
    expect(await getStaffContext()).toBeNull();
  });
});

describe("step-up before reveal, export and refund", () => {
  it("revealing a masked detail asks again after 15 minutes; the password counts for 15 more", async () => {
    const { setFieldRuleAction } = await import("@/app/admin/client-data/actions");
    const { revealClientFieldAction } = await import("@/app/admin/customers/actions");
    const { stepUpAction } = await import("@/app/admin/my-security/actions");
    await signInAs(ids.owner);
    expect(await setFieldRuleAction({ field: "birthday", level: "masked", roleId: null, staffId: ids.michelle, shopId: null })).toMatchObject({ ok: true });
    await signInAs(ids.michelle, shop.coralville);
    const reveal = () => revealClientFieldAction({ customerId: ids.client, field: "birthday", reason: "She asked us to confirm it" });
    expect(await reveal()).toEqual({ ok: true, data: { value: "Apr 2, 1990" } });
    await staleStepUp();
    expect(await reveal()).toMatchObject({ ok: false, stepUp: "reveal" });
    expect(await stepUpAction({ password: "wrong one" })).toMatchObject({ ok: false, error: "That password isn't right" });
    expect(await reveal()).toMatchObject({ ok: false, stepUp: "reveal" });
    expect(await stepUpAction({ password: PASSWORD })).toMatchObject({ ok: true, data: { factor: "password" } });
    expect(await reveal()).toEqual({ ok: true, data: { value: "Apr 2, 1990" } });
    await signInAs(ids.owner);
    await setFieldRuleAction({ field: "birthday", level: null, roleId: null, staffId: ids.michelle, shopId: null });
  });

  it("the client list export sends a stale session to confirm first, then back to the download", async () => {
    const { GET } = await import("@/app/admin/customers/export/route");
    await signInAs(ids.owner);
    expect((await GET(new Request("http://localhost/admin/customers/export?q=Stepwise"))).status).toBe(200);
    await staleStepUp();
    const r = await GET(new Request("http://localhost/admin/customers/export?q=Stepwise"));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/admin/verify?${new URLSearchParams({ for: "export", next: "/admin/customers/export?q=Stepwise" })}`);
  });

  it("a refund without a manager's PIN asks too, before any money moves", async () => {
    const { refundAction } = await import("@/app/admin/sales/actions");
    const sale = (await m.db.db.query.sales.findFirst({ where: eq(S().sales.status, "paid") }))!;
    await signInAs(ids.owner);
    await staleStepUp();
    const before = await m.db.db.select().from(S().refunds).where(eq(S().refunds.saleId, sale.id));
    expect(await refundAction({ saleId: sale.id, items: [], tipCents: 0, refundCardFee: false, reason: "Test", restock: false })).toMatchObject({ ok: false, stepUp: "refund" });
    expect(await m.db.db.select().from(S().refunds).where(eq(S().refunds.saleId, sale.id))).toHaveLength(before.length);
  });

  it("the staff app: reveal answers 403 stepUpRequired after 15 minutes, until POST /me/step-up", async () => {
    await signInAs(ids.owner);
    const { setFieldRuleAction } = await import("@/app/admin/client-data/actions");
    await setFieldRuleAction({ field: "birthday", level: "masked", roleId: null, staffId: ids.michelle, shopId: null });
    const t = await api.login("michelle@rayz.test");
    const reveal = () => api.call("POST", `clients/${ids.client}/reveal`, { token: t.accessToken, shop: shop.coralville, body: { field: "birthday", reason: "She asked us to confirm it" } });
    expect((await reveal()).status).toBe(200);
    await m.db.db.update(S().staffAppTokens).set({ stepUpAt: new Date(Date.now() - 16 * 60_000) }).where(eq(S().staffAppTokens.id, t.sessionId));
    const stale = await reveal();
    expect(stale.status).toBe(403);
    expect(stale.json.error.details).toEqual({ stepUpRequired: "reveal" });
    expect((await api.call("POST", "me/step-up", { token: t.accessToken, body: { password: "nope" } })).status).toBe(401);
    expect((await api.call("POST", "me/step-up", { token: t.accessToken, body: { password: PASSWORD } })).status).toBe(200);
    expect((await reveal()).status).toBe(200);
    await signInAs(ids.owner);
    await setFieldRuleAction({ field: "birthday", level: null, roleId: null, staffId: ids.michelle, shopId: null });
  });
});

describe("new-device alerts", () => {
  it("email them the first time they sign in on a new browser or phone, not the first sign-in ever or a known one", async () => {
    const { noteSignInDevice } = await import("@/server/auth/sign-in-guard");
    const roleId = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.id, ids.makenna) }))!.roleId;
    const [p] = await m.db.db
      .insert(S().staff)
      .values({ staffCode: "S-ND01", firstName: "Nia", lastName: "Newdevice", displayLabel: "Nia N.", publicSlug: "nia-newdevice", email: "nia.newdevice@rayz.test", roleId })
      .returning();
    const alerts = async () => (await m.db.db.select().from(S().notificationJobs).where(eq(S().notificationJobs.to, "nia.newdevice@rayz.test"))).filter((n) => n.kind === "new_sign_in");
    expect(await noteSignInDevice(p, "web", { deviceKey: "browser-one-xxxxxxxxxxxx", label: "Chrome on Windows", ip: null })).toEqual({ isNew: true });
    expect(await alerts()).toHaveLength(0);
    expect(await noteSignInDevice(p, "web", { deviceKey: "browser-one-xxxxxxxxxxxx", label: "Chrome on Windows", ip: null })).toEqual({ isNew: false });
    expect(await noteSignInDevice(p, "app", { deviceKey: "install-two-xxxxxxxxxxx", label: "iPhone", ip: null })).toEqual({ isNew: true });
    const [a] = await alerts();
    expect(a.body).toContain("iPhone");
    expect(a.body).toContain("/admin/my-security");
  });
});

describe("front-desk clock pairing", () => {
  async function pairing(shopId = shop.coralville) {
    const { startPairingAction } = await import("@/app/admin/clock/actions");
    await signInAs(ids.owner);
    const r = await startPairingAction({ shopId, label: "Front desk iPad" });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  it("a manager's code pairs a browser once; it runs the clock with each person's PIN and no session", async () => {
    const { pairThisDeviceAction } = await import("@/app/clock/actions");
    const { kioskStatusAction } = await import("@/app/admin/clock/actions");
    const { setPin } = await import("@/server/time-clock");
    const p = await pairing();
    expect(p.url).toContain(`/clock/pair?code=${encodeURIComponent(p.code)}`);
    expect(p.svg).toContain("<svg");
    await signInAs(null);
    jar.device = undefined;
    expect(await pairThisDeviceAction(p.code.toLowerCase().replace("-", " "))).toEqual({ ok: true, data: { shop: expect.any(String), label: "Front desk iPad" } });
    expect(jar.device).toBeTruthy();
    expect(await pairThisDeviceAction(p.code)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't right or has expired/) });
    await setPin(ids.makenna, "482913", { staffId: ids.makenna, label: "test" });
    expect(await kioskStatusAction({ staffId: ids.makenna, pin: "482913" })).toMatchObject({ ok: true });
    // Only the shop's own team punches on it.
    expect(await kioskStatusAction({ staffId: ids["manager.moline"], pin: "482913" })).toMatchObject({ ok: false, error: "Team member not found" });
    const device = (await m.db.db.query.clockDevices.findFirst({ where: eq(S().clockDevices.tokenHash, (await import("@/server/auth/tokens")).sha256(jar.device!)) }))!;
    expect(device).toMatchObject({ shopId: shop.coralville, registeredBy: ids.owner, installHash: null });
    expect(device.pairedAt).toBeInstanceOf(Date);
    // Revoked in Time clock setup: it stops at once.
    const { revokeDeviceAction } = await import("@/app/admin/clock/actions");
    await signInAs(ids.owner);
    expect(await revokeDeviceAction(device.id)).toMatchObject({ ok: true });
    await signInAs(null);
    expect(await kioskStatusAction({ staffId: ids.makenna, pin: "482913" })).toMatchObject({ ok: false });
    jar.device = undefined;
  });

  it("an expired code doesn't pair, and only a manager with shop settings makes one", async () => {
    const { pairThisDeviceAction } = await import("@/app/clock/actions");
    const { startPairingAction } = await import("@/app/admin/clock/actions");
    const p = await pairing();
    await m.db.db.update(S().clockPairings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(S().clockPairings.id, p.id));
    expect(await pairThisDeviceAction(p.code)).toMatchObject({ ok: false });
    await signInAs(ids.makenna, shop.coralville);
    expect(await startPairingAction({ shopId: shop.coralville, label: "Mine" })).toMatchObject({ ok: false });
  });

  it("the staff app pairs with its install id; the token works with no Bearer only from that install", async () => {
    const p = await pairing();
    const deviceId = `kiosk-install-${crypto.randomUUID()}`;
    const r = await api.call("POST", "clock/kiosk/pair", { body: { code: p.code, deviceId } });
    expect(r.status).toBe(201);
    expect(r.json.device).toMatchObject({ shopId: shop.coralville, label: "Front desk iPad" });
    const kiosk = (headers: Record<string, string>) => api.call("GET", "clock/kiosk", { headers });
    const home = await kiosk({ "x-clock-device": r.json.token, "x-device-id": deviceId });
    expect(home.status).toBe(200);
    expect(home.json).toMatchObject({ shopId: shop.coralville, team: expect.arrayContaining([expect.objectContaining({ id: ids.makenna })]) });
    expect(home.json.queue).not.toBeNull();
    expect((await kiosk({ "x-clock-device": r.json.token, "x-device-id": "another-install-123" })).status).toBe(401);
    expect((await kiosk({ "x-clock-device": r.json.token })).status).toBe(401);
    const punch = await api.call("POST", "clock/kiosk/status", { headers: { "x-clock-device": r.json.token, "x-device-id": deviceId }, body: { staffId: ids.makenna, pin: "482913" } });
    expect(punch.status).toBe(200);
    expect((await api.call("POST", "clock/kiosk/pair", { body: { code: p.code, deviceId } })).status).toBe(400);
  });
});
