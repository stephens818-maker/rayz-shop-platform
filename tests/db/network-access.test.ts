/**
 * Sign-in restrictions against a real database: a location's rule (allowed IPs and CIDR ranges,
 * approved devices, either or both) holds shop logins and staff scoped to it to the shop on every
 * request, in the middleware and in the session itself, not only at sign-in. The client IP comes
 * only from the trusted proxy. "Can access remotely" exempts the Brand Owner and Brand Admin to
 * start, and anyone given it. Someone with several shops keeps the ones they can reach. Trusted
 * devices are requested from a blocked sign-in and approved by a manager or the brand, never by the
 * person who asked. Every blocked attempt is in the audit log with who, the IP, the time and the
 * location, shows in the brand portal, and emails the brand when the alert is on.
 */
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { jar, redirectTarget, signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let net: typeof import("@/server/auth/network");
let auth: typeof import("@/server/auth/staff");
let login: typeof import("@/app/login/actions");
let portal: typeof import("@/app/admin/sign-in-security/actions");
let mw: typeof import("@/middleware");
let BLOCK_MESSAGE = "";
const ids: Record<string, string> = {};
const shopIds: Record<string, string> = {};

const SHOP_IP = "203.0.113.10";
const HOME_IP = "198.51.100.77";
const PASSWORD = process.env.SEED_PASSWORD || "rayz2026!";

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;

beforeAll(async () => {
  m = await loadModules();
  net = await import("@/server/auth/network");
  auth = await import("@/server/auth/staff");
  login = await import("@/app/login/actions");
  portal = await import("@/app/admin/sign-in-security/actions");
  mw = await import("@/middleware");
  BLOCK_MESSAGE = (await import("@/domain/network-access")).BLOCK_MESSAGE;
  for (const k of ["owner", "admin", "regional", "michelle", "makenna", "coralville"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(S().shops)) shopIds[s.slug] = s.id;
}, 180_000);

afterEach(async () => {
  await m.db.db.update(S().shops).set({ networkAccess: {} });
  await m.db.db.update(S().brandSettings).set({ networkAccess: {} });
  await m.db.db.delete(S().trustedDevices);
  for (const k of ["michelle", "admin"]) await m.db.db.update(S().staff).set({ permissionOverrides: {} }).where(eq(S().staff.id, ids[k]));
  Object.assign(jar, { ip: undefined, trusted: undefined, deviceRequest: undefined, userAgent: undefined });
});

afterAll(async () => {
  await m?.db.closeDb();
});

const rule = (slug: string, r: { enabled: boolean; require: "ip" | "device" | "either" | "both"; allowedIps: string[] }) =>
  m.db.db.update(S().shops).set({ networkAccess: r }).where(eq(S().shops.id, shopIds[slug]));

async function ctxAs(staffId: string, ip?: string) {
  await signInAs(staffId);
  jar.ip = ip;
  return auth.getStaffContext();
}

const attempts = (staffId: string, action = "network.blocked") =>
  m.db.db
    .select()
    .from(S().auditLog)
    .where(m.drizzle.and(eq(S().auditLog.action, action), eq(S().auditLog.entityId, staffId)))
    .orderBy(m.drizzle.desc(S().auditLog.at));

async function tryLogin(email: string, password = PASSWORD) {
  const f = new FormData();
  f.set("email", email);
  f.set("password", password);
  try {
    return { state: await login.login(null, f), redirect: null };
  } catch (e) {
    const to = redirectTarget(e);
    if (to) return { state: null, redirect: to };
    throw e;
  }
}

function request(path: string, o: { ip?: string; xff?: string; action?: boolean; device?: string } = {}) {
  const cookie = [`rayz_session=${jar.token}`, o.device && `rayz_trusted_device=${o.device}`].filter(Boolean).join("; ");
  const headers: Record<string, string> = { cookie, "user-agent": "TestBrowser/1.0" };
  if (o.xff ?? o.ip) headers["x-forwarded-for"] = (o.xff ?? o.ip)!;
  if (o.action) headers["next-action"] = "0123abcd";
  return mw.middleware(new NextRequest(`http://localhost${path}`, { method: o.action ? "POST" : "GET", headers }));
}
const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("a location's sign-in rule", () => {
  it("is off to start: everyone signs in from anywhere and nothing else is looked up", async () => {
    expect(await net.anyRuleOn()).toBe(false);
    expect(await ctxAs(ids.makenna, HOME_IP)).not.toBeNull();
    await signInAs(ids.makenna);
    expect(passed(await request("/admin/calendar", { ip: HOME_IP }))).toBe(true);
  });

  it("holds the shop login and the staff scoped to the shop to its network, and an unknown IP fails closed", async () => {
    await rule("coralville", { enabled: true, require: "ip", allowedIps: ["203.0.113.0/28", "2001:db8:42::/48"] });
    expect((await ctxAs(ids.coralville, SHOP_IP))?.shopIds).toEqual([shopIds.coralville]);
    expect(await ctxAs(ids.coralville, HOME_IP)).toBeNull();
    expect(await ctxAs(ids.makenna, HOME_IP)).toBeNull();
    expect(await ctxAs(ids.michelle, HOME_IP)).toBeNull();
    expect(await ctxAs(ids.michelle, "2001:db8:42::5")).not.toBeNull();
    expect(await ctxAs(ids.makenna, undefined)).toBeNull();
    // Other shops' staff aren't affected.
    expect(await ctxAs(ids.regional, HOME_IP)).not.toBeNull();
  });

  it("is enforced by the middleware on every request: a session from outside is refused, signed out and logged", async () => {
    await rule("coralville", { enabled: true, require: "ip", allowedIps: [SHOP_IP] });
    await signInAs(ids.coralville);
    expect(passed(await request("/admin/calendar", { ip: SHOP_IP }))).toBe(true);

    const page = await request("/admin/calendar", { ip: HOME_IP });
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://localhost/login?blocked=1&next=%2Fadmin%2Fcalendar");
    expect(page.headers.get("set-cookie")).toMatch(/rayz_session=;/);

    const action = await request("/admin/sales", { ip: HOME_IP, action: true });
    expect(action.status).toBe(403);
    expect(await action.text()).toBe(BLOCK_MESSAGE);

    const logged = await attempts(ids.coralville);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ shopId: shopIds.coralville, actorStaffId: ids.coralville, entity: "staff" });
    expect(logged[0].details).toMatchObject({ ip: HOME_IP, via: "session", shop: "Coralville", path: "/admin/calendar", missing: "not on the shop's network", userAgent: "TestBrowser/1.0" });
    expect(Date.now() - logged[0].at.getTime()).toBeLessThan(60_000);
  });

  it("only believes the address the trusted proxy added: a client-sent X-Forwarded-For gets nobody in", async () => {
    await rule("coralville", { enabled: true, require: "ip", allowedIps: [SHOP_IP] });
    await signInAs(ids.makenna);
    expect(passed(await request("/admin/calendar", { xff: `${SHOP_IP}, ${HOME_IP}` }))).toBe(false);
    expect(passed(await request("/admin/calendar", { xff: `${HOME_IP}, ${SHOP_IP}` }))).toBe(true);
    const hops = process.env.TRUSTED_PROXY_HOPS;
    delete process.env.TRUSTED_PROXY_HOPS;
    try {
      expect(passed(await request("/admin/calendar", { ip: SHOP_IP }))).toBe(false);
    } finally {
      process.env.TRUSTED_PROXY_HOPS = hops;
    }
  });

  it("doesn't hold back the Brand Owner, the Brand Admin or anyone given Can access remotely", async () => {
    for (const slug of ["coralville", "moline", "rock-island"]) await rule(slug, { enabled: true, require: "ip", allowedIps: [SHOP_IP] });
    expect((await ctxAs(ids.owner, HOME_IP))?.brandWide).toBe(true);
    expect((await ctxAs(ids.admin, HOME_IP))?.brandWide).toBe(true);
    expect(await ctxAs(ids.michelle, HOME_IP)).toBeNull();
    expect(await ctxAs(ids.regional, HOME_IP)).toBeNull();
    await m.db.db.update(S().staff).set({ permissionOverrides: { "access.remote": true } }).where(eq(S().staff.id, ids.michelle));
    expect((await ctxAs(ids.michelle, HOME_IP))?.shopIds).toEqual([shopIds.coralville]);

    const roles = await m.db.db.select().from(S().roles);
    const has = (key: string, p: string) => roles.find((r) => r.key === key)!.permissions.includes(p);
    expect(has("brand_admin", "access.remote")).toBe(true);
    for (const k of ["regional_manager", "shop_manager", "front_desk", "barber"]) expect(has(k, "access.remote")).toBe(false);
    expect(has("shop_manager", "devices.approve") && has("regional_manager", "devices.approve")).toBe(true);
    expect(has("barber", "devices.approve")).toBe(false);
  });

  it("leaves someone with several shops the ones they can reach, and losing any shop ends brand-wide access", async () => {
    await rule("moline", { enabled: true, require: "ip", allowedIps: [SHOP_IP] });
    const regional = await ctxAs(ids.regional, HOME_IP);
    expect(regional?.shopIds).toEqual([shopIds["rock-island"]]);
    expect(regional?.currentShopId).toBe(shopIds["rock-island"]);
    expect(regional?.assignedShops.map((s) => s.id)).toEqual([shopIds["rock-island"]]);
    expect((await ctxAs(ids.regional, SHOP_IP))?.shopIds.sort()).toEqual([shopIds.moline, shopIds["rock-island"]].sort());

    await m.db.db.update(S().staff).set({ permissionOverrides: { "access.remote": false } }).where(eq(S().staff.id, ids.admin));
    const away = (await ctxAs(ids.admin, HOME_IP))!;
    expect(away.brandWide).toBe(false);
    expect(away.shopIds).not.toContain(shopIds.moline);
    expect(away.shopIds).toContain(shopIds.coralville);
    expect(away.permissions.has("catalog.manage")).toBe(false);
    expect(away.permissions.has("sales.view")).toBe(true);
    const there = (await ctxAs(ids.admin, SHOP_IP))!;
    expect(there.brandWide && there.permissions.has("catalog.manage")).toBe(true);
    await signInAs(ids.regional);
    expect(passed(await request("/admin/calendar", { ip: HOME_IP }))).toBe(true);
    expect(await attempts(ids.regional)).toHaveLength(0);
  });
});

describe("signing in", () => {
  it("refuses the right password from outside with the block message and no session, and logs it; a wrong password isn't an attempt", async () => {
    await rule("coralville", { enabled: true, require: "ip", allowedIps: [SHOP_IP] });
    const before = (await attempts(ids.makenna)).length;
    jar.ip = HOME_IP;
    const r = await tryLogin("makenna@rayz.test");
    expect(r.redirect).toBeNull();
    expect(r.state).toEqual({ error: "Sign-in is only allowed from the shop.", blocked: { deviceShops: [] } });
    expect(jar.deviceRequest).toBeUndefined();
    const [row] = await attempts(ids.makenna);
    expect(row).toMatchObject({ shopId: shopIds.coralville, actorLabel: "Barber:Makenna" });
    expect(row.details).toMatchObject({ ip: HOME_IP, via: "sign_in", shop: "Coralville" });

    jar.ip = "192.0.2.50";
    expect((await tryLogin("makenna@rayz.test", "not-the-password")).state).toEqual({ error: "Email or password is incorrect" });
    expect(await attempts(ids.makenna)).toHaveLength(before + 1);

    jar.ip = SHOP_IP;
    expect((await tryLogin("makenna@rayz.test")).redirect).toBe("/admin/calendar");
  });

  it("signs in someone with several shops without the ones out of reach, and says so in the log", async () => {
    await rule("moline", { enabled: true, require: "ip", allowedIps: [SHOP_IP] });
    jar.ip = HOME_IP;
    expect((await tryLogin("regional@rayz.test")).redirect).toBe("/admin");
    const [row] = await attempts(ids.regional, "network.limited");
    expect(row).toMatchObject({ shopId: shopIds.moline });
    expect(await attempts(ids.regional)).toHaveLength(0);
  });

  it("emails the brand about a blocked sign-in once an hour per person and shop, only while the alert is on", async () => {
    await rule("coralville", { enabled: true, require: "ip", allowedIps: [SHOP_IP] });
    const jobs = () => m.db.db.select().from(S().notificationJobs).where(eq(S().notificationJobs.kind, "access_alert"));
    const before = (await jobs()).length;
    jar.ip = "192.0.2.61";
    await tryLogin("frontdesk@rayz.test");
    const sent = (await jobs()).slice(before);
    expect(sent.map((j) => j.to).sort()).toEqual(["admin@rayz.test", "owner@rayz.test"]);
    expect(sent[0]).toMatchObject({ channel: "email", shopId: shopIds.coralville });
    expect(sent[0].body).toContain("192.0.2.61");
    expect(sent[0].subject).toMatch(/sign-in blocked at Coralville/);

    jar.ip = "192.0.2.62";
    await tryLogin("frontdesk@rayz.test");
    expect((await jobs()).length).toBe(before + 2);
    const fd = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, "frontdesk@rayz.test") }))!;
    expect(await attempts(fd.id)).toHaveLength(2);

    await m.db.db.update(S().brandSettings).set({ networkAccess: { alertOnBlock: false } });
    jar.ip = "192.0.2.63";
    await tryLogin("michelle@rayz.test");
    expect((await jobs()).length).toBe(before + 2);
    expect(await attempts(ids.michelle)).toHaveLength(1);
  });
});

describe("trusted devices", () => {
  it("are asked for from a blocked sign-in, approved by a manager, and then sign in from anywhere the rule allows", async () => {
    await rule("coralville", { enabled: true, require: "either", allowedIps: [SHOP_IP] });
    jar.ip = HOME_IP;
    jar.userAgent = "TabletBrowser/2";
    const blocked = await tryLogin("coralville@rayz.test");
    expect(blocked.state?.blocked?.deviceShops).toEqual([{ id: shopIds.coralville, name: "Coralville" }]);
    expect(jar.deviceRequest).toBeTruthy();

    const asked = await login.requestDeviceAction({ shopId: shopIds.coralville, label: "Front desk iPad" });
    expect(asked).toEqual({ ok: true, data: { shop: "Coralville" } });
    expect(jar.trusted).toBeTruthy();
    expect(jar.deviceRequest).toBeUndefined();
    const [row] = await m.db.db.select().from(S().trustedDevices);
    expect(row).toMatchObject({ shopId: shopIds.coralville, status: "pending", requestedBy: ids.coralville, requestedIp: HOME_IP, userAgent: "TabletBrowser/2", label: "Front desk iPad" });
    expect(row.tokenHash).not.toContain(jar.trusted!);
    expect(await login.requestDeviceAction({ shopId: shopIds.coralville, label: "Again" })).toMatchObject({ ok: false });
    expect((await tryLogin("coralville@rayz.test")).state?.error).toBe(BLOCK_MESSAGE);

    const device = jar.trusted!;
    jar.trusted = undefined;
    await signInAs(ids.michelle);
    jar.ip = SHOP_IP;
    expect(await portal.decideDeviceAction(row.id, "approve")).toEqual({ ok: true, data: null });

    jar.trusted = device;
    jar.ip = HOME_IP;
    expect((await tryLogin("coralville@rayz.test")).redirect).toBe("/admin");
    expect(await ctxAs(ids.coralville, HOME_IP)).not.toBeNull();
    expect(passed(await request("/admin/calendar", { ip: HOME_IP, device }))).toBe(true);
    const seen = (await m.db.db.select().from(S().trustedDevices))[0];
    expect(seen).toMatchObject({ status: "approved", decidedBy: ids.michelle, lastIp: HOME_IP });
    expect(seen.lastSeenAt).not.toBeNull();
    const log = await m.db.db.select().from(S().auditLog).where(m.drizzle.and(eq(S().auditLog.entity, "trusted_device"), eq(S().auditLog.entityId, row.id)));
    expect(log.map((l) => l.action).sort()).toEqual(["device.approve", "device.request"]);
  });

  it("can't be approved by the person who asked; 'both' needs the network too; removing one ends it at once; a forged cookie counts for nothing", async () => {
    await rule("coralville", { enabled: true, require: "either", allowedIps: [SHOP_IP] });
    jar.ip = HOME_IP;
    await tryLogin("michelle@rayz.test");
    expect((await login.requestDeviceAction({ shopId: shopIds.coralville, label: "Michelle laptop" })).ok).toBe(true);
    const device = jar.trusted!;
    const [row] = await m.db.db.select().from(S().trustedDevices);
    await signInAs(ids.michelle);
    jar.ip = SHOP_IP;
    expect(await portal.decideDeviceAction(row.id, "approve")).toEqual({ ok: false, error: "You can't approve a device you asked for. Ask another manager or the brand." });
    await signInAs(ids.admin);
    expect((await portal.decideDeviceAction(row.id, "approve")).ok).toBe(true);
    expect(await ctxAs(ids.michelle, HOME_IP)).not.toBeNull();

    await rule("coralville", { enabled: true, require: "both", allowedIps: [SHOP_IP] });
    expect(await ctxAs(ids.michelle, HOME_IP)).toBeNull();
    expect(await ctxAs(ids.michelle, SHOP_IP)).not.toBeNull();
    jar.trusted = undefined;
    expect(await ctxAs(ids.michelle, SHOP_IP)).toBeNull();

    jar.trusted = device;
    await signInAs(ids.admin);
    expect((await portal.decideDeviceAction(row.id, "revoke")).ok).toBe(true);
    expect(await ctxAs(ids.michelle, SHOP_IP)).toBeNull();

    await rule("coralville", { enabled: true, require: "device", allowedIps: [] });
    const { signToken } = await import("@/server/auth/tokens");
    jar.trusted = await signToken({ k: "x".repeat(43) }, "trusted_device", 3600);
    expect(await ctxAs(ids.michelle, SHOP_IP)).toBeNull();
    jar.trusted = `${device.slice(0, -4)}AAAA`;
    expect(await ctxAs(ids.michelle, SHOP_IP)).toBeNull();
  });

  it("can be approved on the spot by a manager signed in on the shop's own device, for their shops only", async () => {
    await rule("coralville", { enabled: true, require: "either", allowedIps: [SHOP_IP] });
    await signInAs(ids.michelle);
    jar.ip = SHOP_IP;
    expect(await portal.trustThisDeviceAction({ shopId: shopIds.moline, label: "Back office" })).toEqual({ ok: false, error: "That device is for a shop outside yours" });
    expect(await portal.trustThisDeviceAction({ shopId: shopIds.coralville, label: "Back office" })).toEqual({ ok: true, data: null });
    const [row] = await m.db.db.select().from(S().trustedDevices);
    expect(row).toMatchObject({ status: "approved", requestedBy: ids.michelle, decidedBy: ids.michelle, shopId: shopIds.coralville });

    await rule("coralville", { enabled: true, require: "device", allowedIps: [] });
    expect(await ctxAs(ids.makenna, HOME_IP)).not.toBeNull();
    const device = jar.trusted;
    jar.trusted = undefined;
    expect(await ctxAs(ids.makenna, HOME_IP)).toBeNull();

    // One browser can count at a second shop: the admin approves the same browser for Moline.
    jar.trusted = device;
    await rule("moline", { enabled: true, require: "device", allowedIps: [] });
    expect(await ctxAs(ids.regional, HOME_IP)).not.toBeNull();
    expect((await ctxAs(ids.regional, HOME_IP))?.shopIds).toEqual([shopIds["rock-island"]]);
    await signInAs(ids.admin);
    expect((await portal.trustThisDeviceAction({ shopId: shopIds.moline, label: "Back office" })).ok).toBe(true);
    expect(jar.trusted).toBe(device);
    expect((await ctxAs(ids.regional, HOME_IP))?.shopIds.sort()).toEqual([shopIds.moline, shopIds["rock-island"]].sort());
  });
});

describe("settings and the brand portal", () => {
  it("only the brand sets rules; every entry is checked; every change is audited", async () => {
    await signInAs(ids.michelle);
    expect((await portal.saveShopRuleAction(shopIds.coralville, { enabled: true, require: "ip", allowedIps: [SHOP_IP] })).ok).toBe(false);

    await signInAs(ids.admin);
    jar.ip = SHOP_IP;
    const save = (allowedIps: string[], require: "ip" | "device" = "ip") => portal.saveShopRuleAction(shopIds.coralville, { enabled: true, require, allowedIps });
    expect(await save(["not-an-ip"])).toMatchObject({ ok: false, error: expect.stringMatching(/isn't an IP address/) });
    expect(await save(["10.0.0.0/8"])).toMatchObject({ ok: false, error: expect.stringMatching(/too much of the internet/) });
    expect(await save([])).toMatchObject({ ok: false, error: expect.stringMatching(/at least one allowed IP/) });
    expect(await save([], "device")).toMatchObject({ ok: true });
    expect(await save([" 203.0.113.0/24 ", "203.0.113.0/24", "2001:db8::/48"])).toEqual({ ok: true, data: { enabled: true, require: "ip", allowedIps: ["203.0.113.0/24", "2001:db8::/48"] } });
    const [log] = await m.db.db.select().from(S().auditLog).where(m.drizzle.and(eq(S().auditLog.action, "network.rule"), eq(S().auditLog.entityId, shopIds.coralville))).orderBy(m.drizzle.desc(S().auditLog.at)).limit(1);
    expect(log.details).toMatchObject({ before: { require: "device" }, after: { allowedIps: ["203.0.113.0/24", "2001:db8::/48"] } });
    expect(await brandAction("setting", "network", { alertOnBlock: false })).toMatchObject({ ok: true });
  });

  it("the wizard saves a new location's rule, and turning one on needs the permission", async () => {
    const { createLocation } = await import("@/server/location-admin");
    const { draftDefaults } = await import("@/domain/location-draft");
    const owner = (await ctxAs(ids.owner, SHOP_IP))!;
    const admin = { actor, brandWide: true, shopIds: owner.shopIds, grantor: auth.staffGrantor(owner) };
    const base = { address: "1 Main St", city: "Davenport", state: "IA", zip: "52801" };
    const networkAccess = { enabled: true, require: "either" as const, allowedIps: ["203.0.113.0/29"] };
    const made = await createLocation(admin, draftDefaults({ ...base, name: "Net Test", slug: "net-test", networkAccess }));
    const saved = await m.db.db.query.shops.findFirst({ where: eq(S().shops.id, made.id) });
    expect(saved?.networkAccess).toEqual(networkAccess);
    const without = { ...admin, grantor: { ...admin.grantor, permissions: new Set([...admin.grantor.permissions].filter((p) => p !== "network.settings")) } };
    await expect(createLocation(without, draftDefaults({ ...base, name: "Net Test 2", slug: "net-test-2", networkAccess }))).rejects.toThrow(/Set where staff can sign in from/);
    await expect(createLocation(admin, draftDefaults({ ...base, name: "Net Test 3", slug: "net-test-3", networkAccess: { ...networkAccess, require: "ip", allowedIps: ["0.0.0.0/0"] } }))).rejects.toThrow();
  });

  it("lists every blocked attempt and the devices in the brand portal; managers see their shops, barbers can't open it", async () => {
    await rule("coralville", { enabled: true, require: "either", allowedIps: [SHOP_IP] });
    jar.ip = "192.0.2.99";
    await tryLogin("makenna@rayz.test");
    await login.requestDeviceAction({ shopId: shopIds.coralville, label: "Makenna phone" });
    jar.trusted = undefined;

    await signInAs(ids.owner);
    jar.ip = SHOP_IP;
    const page = await open("/admin/sign-in-security");
    expect(page.kind).toBe("ok");
    for (const s of ["Blocked sign-ins", "Makenna", "192.0.2.99", "Coralville", "not on the shop's network or an approved device", "Makenna phone", "Waiting for approval", "Brand Admin", SHOP_IP])
      expect(page.text).toContain(s);

    await signInAs(ids.michelle);
    const mine = await open("/admin/sign-in-security");
    expect(mine.kind).toBe("ok");
    expect(mine.text).toContain("The brand sets these.");
    expect(mine.text).toContain("Makenna phone");
    expect(mine.text).not.toContain("Who can sign in from anywhere");

    await signInAs(ids.makenna);
    expect((await open("/admin/sign-in-security")).kind).toBe("denied");

    await signInAs(ids.owner);
    expect((await open("/admin/settings", {}, { shop: shopIds.coralville })).text).toContain("Where staff can sign in");
  });
});
