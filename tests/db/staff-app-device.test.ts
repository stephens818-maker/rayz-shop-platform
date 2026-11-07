/**
 * Approved-device sign-in for the staff app (L36): a location whose sign-in rule takes approved
 * devices lets the app in from off its network once a manager approves that install, the same
 * trusted devices the web uses. A blocked sign-in gets a 15-minute ticket to ask; the device token
 * counts on sign-in and every request once approved, and stops the moment it's removed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

process.env.TRUSTED_PROXY_HOPS ??= "1";

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
let security: typeof import("@/server/sign-in-security");
const ids: Record<string, string> = {};
let coralville = "";

const SHOP_IP = "203.0.113.10";
const HOME_IP = "198.51.100.77";
const PASSWORD = process.env.SEED_PASSWORD || "rayz2026!";

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const rule = (require: "ip" | "device" | "either" | "both") =>
  m.db.db.update(S().shops).set({ networkAccess: { enabled: true, require, allowedIps: require === "device" ? [] : [SHOP_IP] } }).where(eq(S().shops.id, coralville));
const from = (ip: string, device?: string | null) => ({ "x-forwarded-for": ip, "user-agent": "RayzStaff/1.4 iOS", ...(device ? { "x-device-token": device } : {}) });
const signIn = (ip: string, device?: string | null) => api.call("POST", "auth/login", { body: { email: "makenna@rayz.test", password: PASSWORD, deviceName: "Makenna's iPhone" }, headers: from(ip, device) });
const decide = (decision: "approve" | "decline" | "revoke", id: string) =>
  security.decideDevice({ actor: { staffId: ids.michelle, label: "Shop Manager:Michelle" }, staffId: ids.michelle, shopIds: [coralville], canSetRules: false, canApprove: true }, id, decision);

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  security = await import("@/server/sign-in-security");
  for (const k of ["makenna", "michelle"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${k}@rayz.test`) }))!.id;
  coralville = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, "coralville") }))!.id;
}, 240_000);

afterEach(async () => {
  await m.db.db.update(S().shops).set({ networkAccess: {} });
  await m.db.db.delete(S().trustedDevices);
});

afterAll(async () => {
  if (m) await m.db.closeDb();
});

describe("approved-device sign-in for the staff app (L36)", () => {
  it("a blocked sign-in asks for approval; once a manager approves, the device token lets the app in from anywhere", async () => {
    await rule("either");
    const blocked = await signIn(HOME_IP);
    expect(blocked.status, blocked.text).toBe(403);
    expect(blocked.json.error.details).toMatchObject({ networkBlocked: true, deviceShops: [{ id: coralville, name: "Coralville" }] });
    const ticket = blocked.json.error.details.deviceTicket as string;
    expect(ticket).toBeTruthy();

    const asked = await api.call("POST", "auth/device/request", { body: { ticket, shopId: coralville, label: "Makenna's iPhone" }, headers: from(HOME_IP) });
    expect(asked.status, asked.text).toBe(200);
    expect(asked.json).toMatchObject({ shop: "Coralville", status: "pending" });
    const device = asked.json.deviceToken as string;
    expect(device).toBeTruthy();
    const [row] = await m.db.db.select().from(S().trustedDevices);
    expect(row).toMatchObject({ shopId: coralville, status: "pending", requestedBy: ids.makenna, requestedIp: HOME_IP, userAgent: "RayzStaff/1.4 iOS", label: "Makenna's iPhone" });
    expect((await api.call("GET", "auth/device", { headers: from(HOME_IP, device) })).json).toEqual({ devices: [{ shopId: coralville, shop: "Coralville", label: "Makenna's iPhone", status: "pending" }] });
    expect((await api.call("POST", "auth/device/request", { body: { ticket, shopId: coralville }, headers: from(HOME_IP, device) })).status).toBe(409);
    expect((await signIn(HOME_IP, device)).status).toBe(403);

    await decide("approve", row.id);
    const ok = await signIn(HOME_IP, device);
    expect(ok.status, ok.text).toBe(200);
    const token = ok.json.tokens.accessToken as string;
    const me = await api.call("GET", "me", { token, headers: from(HOME_IP, device) });
    expect(me.status, me.text).toBe(200);
    expect(me.json.shops.map((s: { id: string }) => s.id)).toContain(coralville);
    const without = await api.call("GET", "me", { token, headers: from(HOME_IP) });
    expect(without.status).toBe(403);
    expect(without.json.error.details).toMatchObject({ networkBlocked: true, wipe: "cache" });
    const seen = (await m.db.db.select().from(S().trustedDevices))[0];
    expect(seen).toMatchObject({ status: "approved", decidedBy: ids.michelle, lastIp: HOME_IP });
    expect(seen.lastSeenAt).not.toBeNull();
    const audit = await m.db.db.select().from(S().auditLog).where(m.drizzle.and(eq(S().auditLog.entity, "trusted_device"), eq(S().auditLog.entityId, row.id)));
    expect(audit.map((a) => a.action).sort()).toEqual(["device.approve", "device.request"]);

    await decide("revoke", row.id);
    expect((await api.call("GET", "me", { token, headers: from(HOME_IP, device) })).status).toBe(403);
    expect((await signIn(HOME_IP, device)).status).toBe(403);
    expect((await api.call("GET", "auth/device", { headers: from(HOME_IP, device) })).json.devices[0].status).toBe("revoked");
  });

  it("asks while signed in at a location blocked from here, and 'both' still needs the shop's network", async () => {
    await rule("either");
    const at = await signIn(SHOP_IP);
    expect(at.status, at.text).toBe(200);
    const token = at.json.tokens.accessToken as string;
    expect((await api.call("POST", "auth/device/request", { body: { shopId: coralville }, headers: from(SHOP_IP) })).status).toBe(401);
    expect((await api.call("POST", "auth/device/request", { token, body: { shopId: coralville }, headers: from(SHOP_IP) })).status).toBe(403);
    const asked = await api.call("POST", "auth/device/request", { token, body: { shopId: coralville }, headers: from(HOME_IP) });
    expect(asked.status, asked.text).toBe(200);
    const [row] = await m.db.db.select().from(S().trustedDevices);
    expect(row.label).toBe("Ray'z Staff app");
    await decide("approve", row.id);
    const device = asked.json.deviceToken as string;
    expect((await api.call("GET", "me", { token, headers: from(HOME_IP, device) })).status).toBe(200);

    await rule("both");
    expect((await api.call("GET", "me", { token, headers: from(HOME_IP, device) })).status).toBe(403);
    expect((await api.call("GET", "me", { token, headers: from(SHOP_IP, device) })).status).toBe(200);
    expect((await api.call("GET", "me", { token, headers: from(SHOP_IP) })).status).toBe(403);
  });

  it("gives no ticket where only the network counts, and a forged token or ticket counts for nothing", async () => {
    await rule("ip");
    const blocked = await signIn(HOME_IP);
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.details.deviceTicket).toBeUndefined();

    await rule("device");
    const { signToken } = await import("@/server/auth/tokens");
    const forged = await signToken({ k: "x".repeat(43) }, "trusted_device", 3600);
    expect((await signIn(HOME_IP, forged)).status).toBe(403);
    expect((await api.call("GET", "auth/device", { headers: from(HOME_IP, forged) })).json).toEqual({ devices: [] });
    expect((await api.call("POST", "auth/device/request", { body: { ticket: "nope", shopId: coralville }, headers: from(HOME_IP) })).status).toBe(401);
    const other = await signToken({ sub: ids.michelle, shops: [] }, "device_request", 900);
    expect((await api.call("POST", "auth/device/request", { body: { ticket: other, shopId: coralville }, headers: from(HOME_IP) })).status).toBe(403);
  });
});
