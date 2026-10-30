/**
 * Launch security for the front-desk kiosk and the time clock (claude bot, Oct 28), against a real
 * database through /api/staff/v1 and the web actions. In the mobile mock a barber paired their own
 * phone and clocked in from home; here:
 * - only a manager (shop settings) pairs, registers, approves or revokes a kiosk, and every one is
 *   in the audit log; a barber's token can't redeem a manager's pairing code either;
 * - a barber's own token never punches: not by location, Wi-Fi, the NFC sticker or nothing at all,
 *   only with the paired kiosk's single-use QR code;
 * - on the kiosk they tap their tile, then their PIN: five wrong lock it until a manager unlocks
 *   it, wrong PINs are limited per device, and every try is audit-logged;
 * - every punch request's nonce works once (a unique insert) within a minute of its timestamp;
 * - without CLOCK_HMAC_SECRET every clock route refuses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { jar, signInAs } from "./session";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

const PIN = process.env.SEED_CLOCK_PIN ?? "2468";
let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
let clockWeb: typeof import("@/app/admin/clock/actions");
let pairWeb: typeof import("@/app/clock/actions");
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const S = () => m.schema;
const call = (...a: Parameters<typeof api.call>) => api.call(...a);
const login = (email: string) => api.login(email);
const auditOf = (action: string, entityId: string) => m.db.db.select().from(S().auditLog).where(and(eq(S().auditLog.action, action), eq(S().auditLog.entityId, entityId)));
const offTheClock = (staffId: string) => m.db.db.update(S().timePunches).set({ voidedAt: new Date() }).where(and(eq(S().timePunches.staffId, staffId), m.drizzle.isNull(S().timePunches.voidedAt)));
const punchesOf = async (staffId: string) => (await m.db.db.select().from(S().timePunches).where(and(eq(S().timePunches.staffId, staffId), m.drizzle.isNull(S().timePunches.voidedAt)))).length;

/** A manager pairs a kiosk at Coralville through the app: its credential, and its id. */
async function pairedKiosk(label: string) {
  const mgr = await login("michelle@rayz.test");
  const req = await call("POST", "kiosk/pair", { token: mgr.accessToken, body: { shopId: shop.coralville, label } });
  expect(req.status, req.text).toBe(201);
  const ok = await call("POST", `kiosk/pair/${req.json.requestId}/approve`, { token: mgr.accessToken, body: {} });
  expect(ok.status, ok.text).toBe(201);
  onTestFinished(async () => void (await call("POST", `kiosk/${ok.json.kioskId}/revoke`, { token: mgr.accessToken })));
  return { credential: ok.json.credential as string, id: ok.json.kioskId as string, mgr };
}

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  clockWeb = await import("@/app/admin/clock/actions");
  pairWeb = await import("@/app/clock/actions");
  for (const k of ["michelle", "makenna", "kat", "frontdesk"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(S().shops)) shop[s.slug] = s.id;
  const team = await m.db.db
    .select({ id: S().staff.id })
    .from(S().staffShops)
    .innerJoin(S().staff, eq(S().staff.id, S().staffShops.staffId))
    .where(and(eq(S().staffShops.shopId, shop.coralville), eq(S().staff.kind, "person"), eq(S().staff.active, true), m.drizzle.notInArray(S().staff.id, [ids.michelle, ids.makenna, ids.frontdesk])));
  team.slice(0, 3).forEach((t, i) => (ids[`team${i}`] = t.id));
}, 240_000);

beforeEach(async () => {
  await m.db.db.delete(S().apiRateEvents);
  await m.db.db.update(S().staff).set({ clockPinFailures: 0, clockPinLockedUntil: null });
  jar.device = undefined;
});

afterAll(async () => {
  await m?.db.closeDb();
});

describe("pairing and revoking a kiosk", () => {
  it("a barber's token can't pair, register, approve, revoke or redeem; a manager can, and every pairing and revoke is audit-logged", async () => {
    const barber = await login("makenna@rayz.test");
    const mgr = await login("michelle@rayz.test");
    expect((await call("POST", "kiosk/pair", { token: barber.accessToken, body: { shopId: shop.coralville } })).status).toBe(403);
    expect((await call("POST", "clock/kiosk/register", { token: barber.accessToken, body: { shopId: shop.coralville, label: "My phone" } })).status).toBe(403);

    const req = await call("POST", "kiosk/pair", { token: mgr.accessToken, body: { shopId: shop.coralville, label: "Security desk" } });
    expect(req.status, req.text).toBe(201);
    expect((await call("POST", `kiosk/pair/${req.json.requestId}/approve`, { token: barber.accessToken, body: {} })).status).toBe(403);
    // The code the manager's screen shows, typed into the barber's signed-in phone: refused, and the code still works for the tablet.
    const stolen = await call("POST", "clock/kiosk/pair", { token: barber.accessToken, body: { code: req.json.code, deviceId: "barber-phone-install" } });
    expect(stolen.status).toBe(403);
    expect(stolen.json.error.message).toMatch(/Only a manager/);
    const tablet = await call("POST", "clock/kiosk/pair", { body: { code: req.json.code, deviceId: "front-desk-tablet-1" } });
    expect(tablet.status, tablet.text).toBe(201);
    const kioskId = tablet.json.device.id as string;
    expect((await call("POST", `kiosk/${kioskId}/revoke`, { token: barber.accessToken })).status).toBe(403);
    expect((await call("GET", "kiosk/roster", { token: tablet.json.token, headers: { "x-device-id": "front-desk-tablet-1" } })).status).toBe(200);
    expect((await call("POST", `kiosk/${kioskId}/revoke`, { token: mgr.accessToken })).json).toEqual({ kioskId, revoked: true });
    expect((await call("GET", "kiosk/roster", { token: tablet.json.token, headers: { "x-device-id": "front-desk-tablet-1" } })).status).toBe(401);

    const [start] = await auditOf("timeclock.pairing_start", req.json.requestId);
    expect(start).toMatchObject({ actorStaffId: ids.michelle, shopId: shop.coralville });
    const [paired] = await auditOf("timeclock.device_pair", kioskId);
    expect(paired).toMatchObject({ actorStaffId: ids.michelle, shopId: shop.coralville, details: { via: "staff_app" } });
    const [revoked] = await auditOf("timeclock.device_revoke", kioskId);
    expect(revoked).toMatchObject({ actorStaffId: ids.michelle, shopId: shop.coralville });

    const approved = await pairedKiosk("Approved desk");
    expect((await auditOf("kiosk.approve", approved.id))[0]).toMatchObject({ actorStaffId: ids.michelle });
  });

  it("on the web too: a barber can't start a pairing, register this browser, revoke a device or pair their own signed-in browser", async () => {
    await signInAs(ids.makenna);
    expect(await clockWeb.startPairingAction({ shopId: shop.coralville, label: "Mine" })).toMatchObject({ ok: false });
    expect(await clockWeb.registerDeviceAction({ shopId: shop.coralville, label: "Mine" })).toMatchObject({ ok: false });
    expect(jar.device).toBeUndefined();

    await signInAs(ids.michelle);
    const started = await clockWeb.startPairingAction({ shopId: shop.coralville, label: "Web desk" });
    expect(started.ok).toBe(true);
    const code = started.ok ? started.data.code : "";
    await signInAs(ids.makenna);
    expect(await pairWeb.pairThisDeviceAction(code)).toMatchObject({ ok: false, error: expect.stringMatching(/Only a manager/) });
    expect(jar.device).toBeUndefined();
    await signInAs(null);
    const paired = await pairWeb.pairThisDeviceAction(code);
    expect(paired.ok).toBe(true);
    const [device] = await m.db.db.select().from(S().clockDevices).where(eq(S().clockDevices.label, "Web desk"));
    await signInAs(ids.makenna);
    expect(await clockWeb.revokeDeviceAction(device.id)).toMatchObject({ ok: false });
    await signInAs(ids.michelle);
    expect(await clockWeb.revokeDeviceAction(device.id)).toEqual({ ok: true, data: null });
    expect((await auditOf("timeclock.device_revoke", device.id))[0]).toMatchObject({ actorStaffId: ids.michelle });
    jar.device = undefined;
  });
});

describe("clocking in", () => {
  it("a barber's own token can't clock in: not by GPS at the shop, Wi-Fi, the NFC sticker, a copied kiosk token, or nothing", async () => {
    await offTheClock(ids.makenna);
    const barber = await login("makenna@rayz.test");
    const before = await punchesOf(ids.makenna);
    const atShop = { lat: 41.6767, lng: -91.5811, accuracyM: 5 };
    for (const body of [
      { shopId: shop.coralville, confirmTimeOff: true },
      { shopId: shop.coralville, gps: atShop, confirmTimeOff: true },
      { shopId: shop.coralville, proof: { tag: "anything-at-all-000000" }, confirmTimeOff: true },
    ]) {
      const r = await call("POST", "clock/in", { token: barber.accessToken, body, headers: { "x-forwarded-for": "203.0.113.10" } });
      expect(r.status, r.text).toBe(403);
      expect(r.json.error.details).toMatchObject({ reason: "kiosk_required" });
    }
    // A paired kiosk's credential lifted onto the barber's phone, without the kiosk's install id.
    const mgr = await login("michelle@rayz.test");
    const req = await call("POST", "kiosk/pair", { token: mgr.accessToken, body: { shopId: shop.coralville, label: "Bound desk" } });
    const ok = await call("POST", `kiosk/pair/${req.json.requestId}/approve`, { token: mgr.accessToken, body: { deviceId: "bound-desk-install" } });
    onTestFinished(async () => void (await call("POST", `kiosk/${ok.json.kioskId}/revoke`, { token: mgr.accessToken })));
    const lifted = await call("POST", "clock/in", { token: barber.accessToken, headers: { "x-clock-device": ok.json.credential }, body: { shopId: shop.coralville, confirmTimeOff: true } });
    expect(lifted.status).toBe(403);
    // The barber's token is no kiosk either.
    expect((await call("POST", "kiosk/pin", { token: barber.accessToken, body: { staffId: ids.makenna, pin: PIN } })).status).toBe(403);
    expect(await punchesOf(ids.makenna)).toBe(before);

    await signInAs(ids.makenna);
    const web = await clockWeb.punchAction({ shopId: shop.coralville, type: "in", gps: atShop, photo: null, confirmTimeOff: true, nonce: { id: crypto.randomUUID(), at: Date.now() } });
    expect(!web.ok && web.error).toMatch(/A phone on its own can't punch/);
    expect(await punchesOf(ids.makenna)).toBe(before);

    // What does work: the paired kiosk's QR code, scanned once.
    const kiosk = await pairedKiosk("QR desk");
    const qr = await call("GET", "kiosk/qr", { token: kiosk.credential });
    expect(qr.json).toMatchObject({ rotatesSeconds: 15, kioskId: kiosk.id });
    const inn = await call("POST", "clock/in", { token: barber.accessToken, body: { token: qr.json.token, confirmTimeOff: true } });
    expect(inn.status, inn.text).toBe(200);
    const again = await call("POST", "clock/out", { token: barber.accessToken, body: { token: qr.json.token } });
    expect(again.status).toBe(409);
    expect(again.json.error.details).toMatchObject({ reason: "qr_used" });
  });
});

describe("the kiosk PIN", () => {
  it("brute force: five wrong PINs lock it; the right one is still refused until a manager (not the barber) unlocks it; every try audit-logged", async () => {
    await offTheClock(ids.team0);
    const kiosk = await pairedKiosk("PIN desk");
    const barber = await login("makenna@rayz.test");
    const tryPin = (pin: string) => call("POST", "kiosk/pin", { token: kiosk.credential, body: { staffId: ids.team0, pin } });
    for (let i = 0; i < 4; i++) expect((await tryPin("1357")).json.error.message).toBe("Wrong PIN.");
    const fifth = await tryPin("1357");
    expect(fifth.status).toBe(400);
    expect(fifth.json.error.message).toMatch(/locked until a manager unlocks it/);
    for (const pin of [PIN, "1357", PIN]) {
      const r = await tryPin(pin);
      expect(r.status).toBe(409);
      expect(r.json.error.details).toMatchObject({ reason: "pin_locked" });
    }
    expect(await punchesOf(ids.team0)).toBe(0);
    expect((await call("POST", "kiosk/pin/unlock", { token: barber.accessToken, body: { staffId: ids.team0, kioskId: kiosk.id } })).status).toBe(403);
    expect((await call("POST", "kiosk/pin/unlock", { token: kiosk.mgr.accessToken, body: { staffId: ids.team0, kioskId: kiosk.id } })).status).toBe(200);
    const ok = await call("POST", "kiosk/pin", { token: kiosk.credential, body: { staffId: ids.team0, pin: PIN } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ kind: "done", type: "in" });

    const tries = await auditOf("timeclock.pin_attempt", ids.team0);
    expect(tries).toHaveLength(9);
    expect(tries.filter((t) => (t.details as { ok: boolean }).ok)).toHaveLength(1);
    expect(tries.filter((t) => (t.details as { refused?: string }).refused === "locked")).toHaveLength(3);
    for (const t of tries) expect(t).toMatchObject({ shopId: shop.coralville, details: { via: "kiosk_app", deviceId: kiosk.id } });
    expect(await auditOf("timeclock.pin_locked", ids.team0)).toHaveLength(1);
    const view = await call("GET", `audit?shopId=${shop.coralville}`, { token: kiosk.mgr.accessToken });
    expect(view.json.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["timeclock.pin_locked", "timeclock.pin_unlock"]));
  });

  it("wrong PINs are limited per kiosk across everyone's tiles: the 11th try in 15 minutes is a 429", async () => {
    const kiosk = await pairedKiosk("Rate desk");
    const wrong = [ids.team0, ids.team0, ids.team0, ids.team0, ids.team1, ids.team1, ids.team1, ids.team1, ids.team2, ids.team2];
    for (const staffId of wrong) expect((await call("POST", "kiosk/pin", { token: kiosk.credential, body: { staffId, pin: "1357" } })).status).toBe(400);
    const limited = await call("POST", "kiosk/pin", { token: kiosk.credential, body: { staffId: ids.team2, pin: PIN } });
    expect(limited.status).toBe(429);
    expect(limited.json.error.message).toMatch(/Too many wrong PINs on this clock/);
    expect((await auditOf("timeclock.pin_attempt", ids.team2)).find((t) => (t.details as { refused?: string }).refused)?.details).toMatchObject({ ok: false, refused: "rate_limited", deviceId: kiosk.id });
  });
});

describe("nonces", () => {
  it("a replayed kiosk punch, or app punch, is rejected; a stale timestamp too", async () => {
    await offTheClock(ids.team1);
    const kiosk = await pairedKiosk("Nonce desk");
    const headers = { "x-clock-nonce": crypto.randomUUID(), "x-clock-timestamp": String(Date.now()) };
    const send = (h: Record<string, string>, direction = "in") => call("POST", "kiosk/pin", { token: kiosk.credential, noNonce: true, headers: h, body: { staffId: ids.team1, pin: PIN, direction } });
    expect((await send(headers)).status).toBe(200);
    const replay = await send(headers, "out");
    expect(replay.status).toBe(409);
    expect(replay.json.error.details).toMatchObject({ reason: "nonce_replayed" });
    expect((await send({})).json.error.details).toMatchObject({ reason: "nonce_required" });
    expect((await send({ "x-clock-nonce": crypto.randomUUID(), "x-clock-timestamp": String(Date.now() + 2 * 60_000) }, "out")).json.error.details).toMatchObject({ reason: "stale_request" });
    const [row] = await m.db.db.select().from(S().clockNonces).where(eq(S().clockNonces.nonce, `req:${headers["x-clock-nonce"]}`));
    expect(row).toMatchObject({ kind: "request", staffId: ids.team1, deviceId: kiosk.id });
    expect((await send({ "x-clock-nonce": crypto.randomUUID(), "x-clock-timestamp": new Date().toISOString() }, "out")).status).toBe(200);
  });
});

describe("the signing secret", () => {
  it("missing or too short, every clock route refuses (fails closed) and nothing is punched", async () => {
    await offTheClock(ids.team2);
    const kiosk = await pairedKiosk("Secret desk");
    const barber = await login("makenna@rayz.test");
    const qr = (await call("GET", "kiosk/qr", { token: kiosk.credential })).json.token as string;
    const triesBefore = (await auditOf("timeclock.pin_attempt", ids.team2)).length;
    const saved = process.env.CLOCK_HMAC_SECRET;
    onTestFinished(() => void (process.env.CLOCK_HMAC_SECRET = saved));
    for (const value of [undefined, "too-short"]) {
      if (value === undefined) delete process.env.CLOCK_HMAC_SECRET;
      else process.env.CLOCK_HMAC_SECRET = value;
      const refusals = [
        await call("POST", "kiosk/pin", { token: kiosk.credential, body: { staffId: ids.team2, pin: PIN } }),
        await call("GET", "kiosk/qr", { token: kiosk.credential }),
        await call("POST", "clock/kiosk/status", { token: kiosk.credential, headers: { "x-clock-device": kiosk.credential }, body: { staffId: ids.team2, pin: PIN } }),
        await call("POST", "clock/in", { token: barber.accessToken, body: { token: qr, confirmTimeOff: true } }),
      ];
      for (const r of refusals) {
        expect(r.status, r.text).toBe(500);
        expect(r.json.error).toMatchObject({ code: "internal", details: { reason: "clock_secret_missing" }, message: expect.stringMatching(/CLOCK_HMAC_SECRET/) });
      }
      await signInAs(ids.makenna);
      const web = await clockWeb.punchAction({ shopId: shop.coralville, type: "in", gps: null, photo: null, nonce: { id: crypto.randomUUID(), at: Date.now() } });
      expect(!web.ok && web.error).toMatch(/CLOCK_HMAC_SECRET/);
    }
    expect(await punchesOf(ids.team2)).toBe(0);
    expect(await auditOf("timeclock.pin_attempt", ids.team2)).toHaveLength(triesBefore);
    process.env.CLOCK_HMAC_SECRET = saved;
    expect((await call("POST", "kiosk/pin", { token: kiosk.credential, body: { staffId: ids.team2, pin: PIN } })).status).toBe(200);
  });
});
