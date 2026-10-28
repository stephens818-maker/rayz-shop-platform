/**
 * The consent record and app devices (C20, C3–C5): every yes and no is a consent_events row with the
 * wording's version and where it happened; marketing is a separate yes that only the client gives;
 * Squire opt-ins are appointment consent only; STOP and START are recorded for everyone on the number;
 * marketing texts wait for 8 AM where the recipient is; devices register, rotate and revoke; appointment
 * push goes to the household's devices once turned on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let consentRoute: typeof import("@/app/api/v1/me/consent/route");
let devicesRoute: typeof import("@/app/api/v1/me/devices/route");
let deviceRoute: typeof import("@/app/api/v1/me/devices/[id]/route");
let meRoute: typeof import("@/app/api/v1/me/route");
let line: typeof import("@/server/shop-line");
let texts: typeof import("@/domain/consent-texts");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const actor = { staffId: null, label: "test" };

let n = 0;
const phone = (area = "319") => `+1${area}778${String(1000 + ++n).padStart(4, "0")}`;
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const events = (customerId: string) =>
  m.db.db.select().from(m.schema.consentEvents).where(eq(m.schema.consentEvents.customerId, customerId)).orderBy(m.schema.consentEvents.createdAt, m.schema.consentEvents.channel);
const row = (id: string) => m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, id) });
async function signedIn(id: string, client: "ios" | "android" | "web" = "ios") {
  const { accessToken } = await m.auth.issueTokens(id, "phone");
  return { authorization: `Bearer ${accessToken}`, "x-client": client, "x-app-version": "2.4.0" };
}

beforeAll(async () => {
  m = await loadModules();
  consentRoute = await import("@/app/api/v1/me/consent/route");
  devicesRoute = await import("@/app/api/v1/me/devices/route");
  deviceRoute = await import("@/app/api/v1/me/devices/[id]/route");
  meRoute = await import("@/app/api/v1/me/route");
  line = await import("@/server/shop-line");
  texts = await import("@/domain/consent-texts");
});

afterAll(async () => {
  await m?.db.closeDb();
});

describe("the consent record (C20)", () => {
  it("records a yes with the wording's version, the app and its version; an old wording is refused", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Cora", lastName: "Lind", phone: phone() }, null);
    const auth = await signedIn(c.id);
    const state = await (await consentRoute.GET(req("/api/v1/me/consent", { headers: auth }), ctx({}))).json();
    const sms = state.channels.find((x: { channel: string }) => x.channel === "sms_marketing");
    expect(sms).toMatchObject({ granted: false, marketing: true, textVersion: texts.CONSENT_TEXTS.sms_marketing.version, blockedBy: null });
    expect(sms.text).toMatch(/Reply STOP/);

    const stale = await consentRoute.PUT(
      req("/api/v1/me/consent", { method: "PUT", headers: auth, body: JSON.stringify({ changes: [{ channel: "sms_marketing", granted: true, textVersion: "sms-marketing-2020-01-01" }] }) }),
      ctx({}),
    );
    expect(stale.status).toBe(400);
    expect((await stale.json()).error.details.textVersion).toBe(sms.textVersion);

    const ok = await consentRoute.PUT(
      req("/api/v1/me/consent", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({
          changes: [
            { channel: "sms_marketing", granted: true, textVersion: sms.textVersion },
            { channel: "push_transactional", granted: true, textVersion: texts.CONSENT_TEXTS.push_transactional.version },
          ],
        }),
      }),
      ctx({}),
    );
    expect(ok.status).toBe(200);
    expect(await row(c.id)).toMatchObject({ smsMarketingOptIn: true, pushTransactional: true, smsOptIn: false });
    expect((await events(c.id)).map((e) => [e.channel, e.action, e.source, e.appVersion, e.textVersion, !!e.phone])).toEqual([
      ["push_transactional", "granted", "ios", "2.4.0", texts.CONSENT_TEXTS.push_transactional.version, false],
      ["sms_marketing", "granted", "ios", "2.4.0", sms.textVersion, true],
    ]);
    const me = await (await meRoute.GET(req("/api/v1/me", { headers: auth }), ctx({}))).json();
    expect(me).toMatchObject({ smsMarketingOptIn: true, pushTransactional: true, emailMarketingOptIn: false, pushMarketing: false });
  });

  it("turning marketing off cancels what's queued; marketing email needs a confirmed email", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Dale", lastName: "Fenn", phone: phone(), email: `dale${n}@consent.test` }, null);
    const auth = await signedIn(c.id, "android");
    const v = texts.CONSENT_TEXTS;
    const put = (changes: unknown[]) => consentRoute.PUT(req("/api/v1/me/consent", { method: "PUT", headers: auth, body: JSON.stringify({ changes }) }), ctx({}));
    const noEmail = await put([{ channel: "email_marketing", granted: true, textVersion: v.email_marketing.version }]);
    expect(noEmail.status).toBe(400);
    await m.db.db.update(m.schema.customers).set({ emailVerifiedAt: new Date() }).where(eq(m.schema.customers.id, c.id));
    expect(
      (
        await put([
          { channel: "email_marketing", granted: true, textVersion: v.email_marketing.version },
          { channel: "sms_marketing", granted: true, textVersion: v.sms_marketing.version },
        ])
      ).status,
    ).toBe(200);
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const [job] = await m.db.db
      .insert(m.schema.notificationJobs)
      .values({ kind: "marketing", channel: "sms", to: c.phone!, body: "Open chair at 3", customerId: c.id, shopId: shop.id, runAt: new Date(Date.now() + 3600_000) })
      .returning();
    expect((await put([{ channel: "sms_marketing", granted: false }])).status).toBe(200);
    expect((await m.db.db.query.notificationJobs.findFirst({ where: eq(m.schema.notificationJobs.id, job.id) }))?.status).toBe("cancelled");
    expect(await row(c.id)).toMatchObject({ smsMarketingOptIn: false, emailMarketingOptIn: true });
    expect((await events(c.id)).filter((e) => e.channel === "sms_marketing").map((e) => e.action)).toEqual(["granted", "revoked"]);
  });

  it("booking on the website records the appointment-text yes as web; staff edits are recorded as staff", async () => {
    const p = phone();
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const c = await m.db.db.transaction((tx) =>
      m.customers.findOrCreateCustomer({ firstName: "Elle", lastName: "Gray", phone: p, smsOptIn: true }, shop.id, tx, { consent: { source: "web", ip: "203.0.113.9" } }),
    );
    expect((await events(c.id)).map((e) => [e.channel, e.action, e.source, e.ip, e.textVersion])).toEqual([
      ["sms_transactional", "granted", "web", "203.0.113.9", texts.CONSENT_TEXTS.sms_transactional.version],
    ]);
    await m.db.db.transaction((tx) => m.customers.findOrCreateCustomer({ firstName: "Elle", lastName: "Gray", phone: p, smsOptIn: false }, shop.id, tx));
    expect((await events(c.id)).at(-1)).toMatchObject({ channel: "sms_transactional", action: "revoked", source: "pos", textVersion: "staff-edit" });
  });

  it("keeps the record: rows can't be edited or deleted", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Finn", lastName: "Hale", phone: phone(), smsOptIn: true }, null);
    const [e] = await events(c.id);
    await expect(m.db.db.delete(m.schema.consentEvents).where(eq(m.schema.consentEvents.id, e.id))).rejects.toThrow();
    await expect(m.db.db.update(m.schema.consentEvents).set({ action: "revoked" }).where(eq(m.schema.consentEvents.id, e.id))).rejects.toThrow();
  });

  it("a child profile holds no consent of its own, marketing and push included", async () => {
    const parent = await m.customers.findOrCreateCustomer({ firstName: "Gina", lastName: "Ives", phone: phone() }, null);
    const fam = await import("@/server/family");
    const kid = await fam.addChild(parent.id, { firstName: "Hal", age: 7 }, actor);
    await m.db.db.update(m.schema.customers).set({ smsMarketingOptIn: true, pushTransactional: true, pushMarketing: true }).where(eq(m.schema.customers.id, kid.id));
    expect(await row(kid.id)).toMatchObject({ smsMarketingOptIn: false, pushTransactional: false, pushMarketing: false });
  });
});

describe("Squire opt-ins (C20)", () => {
  it("count as appointment consent only, recorded as imported, and never override a later choice", async () => {
    const p = phone();
    const csv = (sms: string) => `Client ID,First Name,Last Name,Phone,SMS Opt In\nSQ-CONSENT-1,Ivy,Jett,${p},${sms}\n`;
    await m.importer.runImport("clients", csv("yes"), { dryRun: false, actor, filename: "clients.csv" });
    const c = (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.phone, p) }))!;
    expect(c).toMatchObject({ smsOptIn: true, smsMarketingOptIn: false, emailMarketingOptIn: false, pushMarketing: false });
    expect((await events(c.id)).map((e) => [e.channel, e.action, e.source, e.textVersion])).toEqual([["sms_transactional", "granted", "import", "squire-import"]]);

    const auth = await signedIn(c.id, "web");
    await meRoute.PATCH(req("/api/v1/me", { method: "PATCH", headers: auth, body: JSON.stringify({ smsOptIn: false }) }), ctx({}));
    await m.importer.runImport("clients", csv("yes"), { dryRun: false, actor, filename: "clients.csv" });
    expect((await row(c.id))?.smsOptIn).toBe(false);
    expect((await events(c.id)).map((e) => [e.action, e.source])).toEqual([
      ["granted", "import"],
      ["revoked", "web"],
    ]);
  });
});

describe("STOP, START and HELP (C20)", () => {
  it("records STOP and START for everyone on the number, and counts them on a number that isn't a shop line", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    if (!shop.twilioNumber) await m.db.db.update(m.schema.shops).set({ twilioNumber: "+13195550199" }).where(eq(m.schema.shops.id, shop.id));
    const to = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, shop.id) }))!.twilioNumber!;
    const p = phone();
    const a = await m.customers.findOrCreateCustomer({ firstName: "Jo", lastName: "Kay", phone: p, smsOptIn: true }, null);
    const b = await m.customers.findOrCreateCustomer({ firstName: "Kit", lastName: "Kay", phone: p }, null);
    await m.db.db.update(m.schema.customers).set({ smsMarketingOptIn: true }).where(eq(m.schema.customers.id, b.id));

    await line.handleInboundSms({ from: p, to, body: "stop" });
    expect((await events(a.id)).at(-1)).toMatchObject({ channel: "sms_transactional", action: "revoked", source: "sms", textVersion: "STOP" });
    expect((await events(b.id)).map((e) => [e.channel, e.action])).toEqual([["sms_marketing", "revoked"]]);
    await line.handleInboundSms({ from: p, to, body: "START" });
    expect((await row(a.id))?.smsOptIn).toBe(true);
    expect((await events(b.id)).at(-1)).toMatchObject({ channel: "sms_marketing", action: "granted", textVersion: "START" });

    const p2 = phone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Lu", lastName: "Moss", phone: p2, smsOptIn: true }, null);
    const r = await line.handleInboundSms({ from: p2, to: "+13195550000", body: "Unsubscribe", optOutType: "STOP" });
    expect(r.handled).toBe("unknown_line");
    expect((await row(c.id))?.smsOptIn).toBe(false);
    const help = await line.handleInboundSms({ from: p2, to: "+13195550000", body: "what is this" });
    expect(help.twiml).toMatch(/<Message>.*STOP/);
  });
});

describe("quiet hours where the recipient is (C20)", () => {
  it("holds marketing and reminders to a Los Angeles number until 9 AM Pacific; a confirmation goes now (Charles, Oct 28)", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const barber = (await m.db.db.query.staffShops.findFirst({ where: eq(m.schema.staffShops.shopId, shop.id) }))!;
    const la = phone("213");
    const now = m.time.zonedWallTime(m.time.addDays(m.time.todayLocal(), 30), 9 * 60).toJSDate(); // 9 AM Central, 7 AM Pacific
    const soon = new Date(now.getTime() + 90 * 60_000);
    const [a] = await m.db.db
      .insert(m.schema.appointments)
      .values({ code: `Q${crypto.randomUUID().slice(0, 7).toUpperCase()}`, shopId: shop.id, staffId: barber.staffId, startsAt: soon, endsAt: new Date(soon.getTime() + 30 * 60_000), status: "booked", source: "staff", estimateCents: 2300 })
      .returning();
    const job = async (kind: string, appointmentId: string | null = null) =>
      (await m.db.db.insert(m.schema.notificationJobs).values({ kind, channel: "sms", to: la, body: "Hi", shopId: shop.id, runAt: now, appointmentId }).returning())[0];
    const mk = await job("marketing");
    const remind = await job("reminder_24h");
    const late = await job("reminder_2h", a.id);
    const confirm = await job("confirmation");
    const stats = await m.queue.processDueJobs({ now, ids: [mk.id, remind.id, late.id, confirm.id] });
    expect(stats.deferred).toBe(2);
    const get = async (id: string) => (await m.db.db.query.notificationJobs.findFirst({ where: eq(m.schema.notificationJobs.id, id) }))!;
    for (const held of [await get(mk.id), await get(remind.id)]) {
      expect(held.status).toBe("pending");
      expect(held.runAt.getTime() - now.getTime()).toBe(2 * 3600_000);
    }
    // 9 AM Pacific is after the appointment starts: not sent at all.
    expect(await get(late.id)).toMatchObject({ status: "suppressed", lastError: expect.stringMatching(/9 AM to 8 PM/) });
    expect((await get(confirm.id)).status).not.toBe("pending");
  });
});

describe("app devices and appointment push (C3–C5)", () => {
  it("registers, moves a token to whoever signs in, rotates, revokes, and pushes appointment messages once turned on", async () => {
    const a = await m.customers.findOrCreateCustomer({ firstName: "Mo", lastName: "Nash", phone: phone() }, null);
    const b = await m.customers.findOrCreateCustomer({ firstName: "Ned", lastName: "Oaks", phone: phone() }, null);
    const authA = await signedIn(a.id);
    const authB = await signedIn(b.id);
    const reg = (auth: Record<string, string>, body: unknown) => devicesRoute.POST(req("/api/v1/me/devices", { method: "POST", headers: auth, body: JSON.stringify(body) }), ctx({}));

    expect((await reg(authA, { platform: "ios", provider: "fcm", token: "tok-ios-1234" })).status).toBe(400);
    const r1 = await reg(authA, { platform: "ios", provider: "apns", token: `apns-${a.id}`, appVersion: "2.4.0" });
    expect(r1.status).toBe(201);
    const { device } = await r1.json();
    const moved = await (await reg(authB, { platform: "ios", provider: "apns", token: `apns-${a.id}` })).json();
    expect(moved.device.id).toBe(device.id);
    expect((await (await devicesRoute.GET(req("/api/v1/me/devices", { headers: authA }), ctx({}))).json()).devices).toEqual([]);

    const rotated = await deviceRoute.PATCH(
      req(`/api/v1/me/devices/${device.id}`, { method: "PATCH", headers: authB, body: JSON.stringify({ token: `apns-rotated-${b.id}`, pushEnabled: true }) }),
      ctx({ id: device.id }),
    );
    expect(rotated.status).toBe(200);
    expect((await deviceRoute.PATCH(req(`/api/v1/me/devices/${device.id}`, { method: "PATCH", headers: authA, body: JSON.stringify({ pushEnabled: false }) }), ctx({ id: device.id }))).status).toBe(
      404,
    );

    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const msg = {
      appointmentId: null as unknown as string,
      code: "PUSH01",
      startsAt: new Date(Date.now() + 86_400_000),
      shopId: shop.id,
      shopName: shop.name,
      shopAddress: "1 Main",
      barberName: "Ray",
      customerId: b.id,
      phone: null,
      email: null,
      smsOptIn: false,
      emailOptIn: false,
    };
    expect(await m.queue.queueAppointmentMessage("confirmation", msg)).toHaveLength(0);
    await m.db.db.update(m.schema.customers).set({ pushTransactional: true }).where(eq(m.schema.customers.id, b.id));
    const ids = await m.queue.queueAppointmentMessage("confirmation", msg);
    expect(ids).toHaveLength(1);
    expect(await m.db.db.query.notificationJobs.findFirst({ where: eq(m.schema.notificationJobs.id, ids[0]) })).toMatchObject({ channel: "push", to: device.id });

    expect((await deviceRoute.DELETE(req(`/api/v1/me/devices/${device.id}`, { method: "DELETE", headers: authB }), ctx({ id: device.id }))).status).toBe(204);
    expect(await m.queue.queueAppointmentMessage("confirmation", msg)).toHaveLength(0);
  });

  it("deleting the account revokes its devices and keeps the consent record without the phone", async () => {
    const p = phone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Opal", lastName: "Pike", phone: p, smsOptIn: true }, null);
    const auth = await signedIn(c.id);
    await devicesRoute.POST(req("/api/v1/me/devices", { method: "POST", headers: auth, body: JSON.stringify({ platform: "android", provider: "fcm", token: `fcm-${c.id}` }) }), ctx({}));
    const del = await import("@/server/account-deletion");
    await del.deleteAccount(actor, c.id, { source: "test" });
    expect(await m.db.db.query.customerDevices.findFirst({ where: eq(m.schema.customerDevices.customerId, c.id) })).toMatchObject({ pushEnabled: false });
    expect((await m.db.db.query.customerDevices.findFirst({ where: eq(m.schema.customerDevices.customerId, c.id) }))?.revokedAt).not.toBeNull();
    const rec = await events(c.id);
    expect(rec.map((e) => [e.channel, e.action])).toEqual([
      ["sms_transactional", "granted"],
      ["sms_transactional", "revoked"],
    ]);
    expect(rec.every((e) => e.phone === null && e.email === null)).toBe(true);
  });
});
