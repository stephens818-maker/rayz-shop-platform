/**
 * I14 guest booking, I16 the 13+ gate, I15 "Secure my profile" and claiming a child, I1 a card on
 * file for barbers who need one, and the C18 App Review sign-in scaffold (off unless its env is set):
 * the app books signed in only; a website guest never lands on an existing profile, is rate-limited
 * and bot-checked, and an unverified number gets one confirmation text a day; signing in by phone
 * folds that guest record into the profile.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let apptRoute: typeof import("@/app/api/v1/appointments/route");
let verifyRoute: typeof import("@/app/api/v1/auth/otp/verify/route");
let secureRoute: typeof import("@/app/api/v1/me/secure/route");
let claimRoute: typeof import("@/app/api/v1/me/family/claim/route");
let meRoute: typeof import("@/app/api/v1/me/route");
let configRoute: typeof import("@/app/api/v1/app/config/route");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const S = () => m.schema;

let n = 0;
const phone = () => `+1319888${String(1000 + ++n).padStart(4, "0")}`;
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const codeFor = async (p: { phone?: string; email?: string }) => (await m.auth.startOtp(p)).devCode!;
const bearer = async (customerId: string) => ({ authorization: `Bearer ${(await m.auth.issueTokens(customerId, null)).accessToken}` });
const row = async (id: string) => (await m.db.db.query.customers.findFirst({ where: eq(S().customers.id, id) }))!;

const REVIEW_ENV = ["FEATURE_REVIEW_LOGIN", "APP_REVIEW_PHONE", "APP_REVIEW_CODE", "APP_REVIEW_EMAIL", "APP_REVIEW_SHOP", "TURNSTILE_SECRET_KEY", "STRIPE_SECRET_KEY"];

/** The next open slot at Coralville, at least three days out. */
async function openSlot() {
  const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
  for (let i = 3; i < 30; i++) {
    const date = m.time.addDays(m.time.todayLocal(), i);
    const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id });
    if (a.slots.length) return { svc, slot: a.slots[0] };
  }
  throw new Error("no slots");
}

async function book(customer: Record<string, unknown> | null, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const { svc, slot } = await openSlot();
  const payload = { shopId: "coralville", serviceId: svc.id, barberId: slot.barberIds[0], startsAt: slot.startsAt, ...(customer ? { customer } : {}), ...extra };
  return apptRoute.POST(req("/api/v1/appointments", { method: "POST", headers, body: JSON.stringify(payload) }), ctx({}));
}

async function apptByCode(code: string) {
  return (await m.db.db.query.appointments.findFirst({ where: eq(S().appointments.code, code) }))!;
}

beforeAll(async () => {
  m = await loadModules();
  process.env.AUTH_DEV_CODES = "true";
  apptRoute = await import("@/app/api/v1/appointments/route");
  verifyRoute = await import("@/app/api/v1/auth/otp/verify/route");
  secureRoute = await import("@/app/api/v1/me/secure/route");
  claimRoute = await import("@/app/api/v1/me/family/claim/route");
  meRoute = await import("@/app/api/v1/me/route");
  configRoute = await import("@/app/api/v1/app/config/route");
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of REVIEW_ENV) delete process.env[k];
});

afterAll(async () => {
  await m?.db.closeDb();
});

describe("guest booking (I14)", () => {
  it("the app must sign in to book; the website guest says they're 13 or older", async () => {
    const app = await book({ firstName: "Ann", phone: phone(), smsOptIn: true, ageConfirmed: true }, { "x-client": "ios" });
    expect(app.status).toBe(401);
    expect((await app.json()).error.details).toEqual({ reason: "sign_in_required" });
    const young = await book({ firstName: "Bo", phone: phone(), ageConfirmed: false });
    expect(young.status).toBe(403);
    expect((await young.json()).error.details).toEqual({ reason: "under_13" });
  });

  it("never lands on an existing profile: a separate unverified record until the phone signs in, then it folds in", async () => {
    const p = phone();
    const real = await m.customers.findOrCreateCustomer({ firstName: "Tess", lastName: "Arden", phone: p, email: "tess.real@guest.test", smsOptIn: true, emailOptIn: true }, null);
    const first = await book({ firstName: "Tess", lastName: "Someone", phone: p, email: "other@guest.test", smsOptIn: false, emailOptIn: false, ageConfirmed: true });
    expect(first.status).toBe(201);
    const a1 = await apptByCode((await first.json()).appointment.code);
    expect(a1.customerId).not.toBe(real.id);
    expect(await row(real.id)).toMatchObject({ smsOptIn: true, emailOptIn: true, lastName: "Arden", email: "tess.real@guest.test", unverifiedGuestAt: null });
    const guest = await row(a1.customerId!);
    expect(guest.unverifiedGuestAt).not.toBeNull();
    expect(guest.ageConfirmedAt).not.toBeNull();

    const second = await book({ firstName: "Tess", phone: p, smsOptIn: true, ageConfirmed: true });
    const a2 = await apptByCode((await second.json()).appointment.code);
    expect(a2.customerId).toBe(guest.id);

    // Two adults named Tess on the number: the code asks for a name, then the guest record folds into the real one.
    const v = await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) });
    if (!("selectionToken" in v) || !v.needsProfile) throw new Error("expected a name prompt");
    const done = await m.auth.completeSignIn({ selectionToken: v.selectionToken, firstName: "Tess" });
    if (!("accessToken" in done)) throw new Error("expected tokens");
    expect(done.customer.id).toBe(real.id);
    expect(await m.db.db.query.customers.findFirst({ where: eq(S().customers.id, guest.id) })).toBeUndefined();
    expect((await apptByCode(a1.code)).customerId).toBe(real.id);
    expect((await apptByCode(a2.code)).customerId).toBe(real.id);
    expect((await row(real.id)).unverifiedGuestAt).toBeNull();
  });

  it("a new number's guest record becomes the profile when that phone signs in", async () => {
    const p = phone();
    const res = await book({ firstName: "Uri", phone: p, smsOptIn: true, ageConfirmed: true });
    const a = await apptByCode((await res.json()).appointment.code);
    expect((await row(a.customerId!)).unverifiedGuestAt).not.toBeNull();
    const r = await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) });
    expect("accessToken" in r && r.customer.id).toBe(a.customerId);
    expect((await row(a.customerId!)).unverifiedGuestAt).toBeNull();
  });

  it("an unverified number gets one confirmation text a day", async () => {
    const p = phone();
    const codes: string[] = [];
    for (let i = 0; i < 2; i++) codes.push((await (await book({ firstName: "Vera", phone: p, smsOptIn: true, ageConfirmed: true })).json()).appointment.code);
    const confirmations = async (code: string) =>
      (
        await m.db.db
          .select()
          .from(S().notificationJobs)
          .where(and(eq(S().notificationJobs.appointmentId, (await apptByCode(code)).id), eq(S().notificationJobs.kind, "confirmation"), eq(S().notificationJobs.channel, "sms")))
      ).length;
    expect(await confirmations(codes[0])).toBe(1);
    expect(await confirmations(codes[1])).toBe(0);
  });

  it("limits guest bookings per phone, and checks for bots once Turnstile is set up", async () => {
    const p = phone();
    for (let i = 0; i < 5; i++) await m.rateLimit.rateLimit("guest_booking_contact", p, 5, 86_400_000);
    const limited = await book({ firstName: "Wes", phone: p, ageConfirmed: true });
    expect(limited.status).toBe(429);

    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const token = new URLSearchParams(String(init.body)).get("response")!;
        calls.push(token);
        return new Response(JSON.stringify({ success: token === "good" }), { status: 200 });
      }),
    );
    const none = await book({ firstName: "Xia", phone: phone(), ageConfirmed: true });
    expect((await none.json()).error.details).toEqual({ reason: "bot_check_required" });
    const bad = await book({ firstName: "Xia", phone: phone(), ageConfirmed: true }, {}, { captchaToken: "bad" });
    expect(bad.status).toBe(403);
    expect((await bad.json()).error.details).toEqual({ reason: "bot_check_failed" });
    const good = await book({ firstName: "Xia", phone: phone(), smsOptIn: true, ageConfirmed: true }, { "cf-turnstile-response": "good" });
    expect(good.status).toBe(201);
    expect(calls).toEqual(["bad", "good"]);
  });
});

describe("a card on file for barbers who need one (I1)", () => {
  it("the app refuses without a saved card; a dependent books on the guardian's card", async () => {
    const cv = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, "coralville") }))!;
    const links = await m.db.db.select().from(S().staffShops).where(eq(S().staffShops.shopId, cv.id));
    await Promise.all(
      links.map((l) =>
        m.db.db
          .update(S().staffShops)
          .set({ bookingOptions: { ...(l.bookingOptions as object), bookWithoutPayment: false } })
          .where(and(eq(S().staffShops.staffId, l.staffId), eq(S().staffShops.shopId, l.shopId))),
      ),
    );
    try {
      const parent = await m.customers.findOrCreateCustomer({ firstName: "Gwen", phone: phone() }, null);
      const refused = await book(null, await bearer(parent.id));
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.details).toEqual({ reason: "card_required" });

      const fam = await import("@/server/family");
      const kid = await fam.addChild(parent.id, { firstName: "Hal", birthYear: 2018 }, actor);
      await m.db.db
        .insert(S().customerCards)
        .values({ customerId: parent.id, stripePaymentMethodId: `pm_test_${parent.id.slice(0, 8)}`, brand: "visa", last4: "4242", funding: "credit", isDefault: true });
      expect((await book(null, await bearer(parent.id))).status).toBe(201);
      const { svc, slot } = await openSlot();
      const a = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: slot.barberIds[0], startsAt: slot.startsAt, customerId: kid.id, source: "api", actor });
      expect(a.status).toBe("booked");
    } finally {
      await Promise.all(
        links.map((l) =>
          m.db.db
            .update(S().staffShops)
            .set({ bookingOptions: l.bookingOptions })
            .where(and(eq(S().staffShops.staffId, l.staffId), eq(S().staffShops.shopId, l.shopId))),
        ),
      );
    }
  });
});

describe("the 13+ gate (I16)", () => {
  it("a new account from the app has to confirm 13 or older; under 13 is refused; existing profiles aren't asked", async () => {
    const verify = (body: object) => verifyRoute.POST(req("/api/v1/auth/otp/verify", { method: "POST", headers: { "x-client": "android" }, body: JSON.stringify(body) }), ctx({}));
    const p = phone();
    const missing = await verify({ phone: p, code: await codeFor({ phone: p }), firstName: "Ivy" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.details).toMatchObject({ reason: "age_confirmation_required" });
    const young = await verify({ phone: p, code: await codeFor({ phone: p }), firstName: "Ivy", ageConfirmed: false });
    expect(young.status).toBe(403);
    expect((await young.json()).error.details).toEqual({ reason: "under_13" });
    expect(await m.db.db.select().from(S().customers).where(eq(S().customers.phone, p))).toEqual([]);

    const ok = await (await verify({ phone: p, code: await codeFor({ phone: p }), firstName: "Ivy", ageConfirmed: true })).json();
    expect(ok.isNew).toBe(true);
    expect((await row(ok.customer.id)).ageConfirmedAt).not.toBeNull();
    const again = await verify({ phone: p, code: await codeFor({ phone: p }) });
    expect(again.status).toBe(200);
    expect((await again.json()).customer.id).toBe(ok.customer.id);
  });
});

describe("Secure my profile and claiming a child (I15)", () => {
  it("needs a verified email; then a phone code also needs the email code", async () => {
    const p = phone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Jo", phone: p, email: "jo@secure.test" }, null);
    const auth = await bearer(c.id);
    const put = (secured: boolean) => secureRoute.PUT(req("/api/v1/me/secure", { method: "PUT", headers: auth, body: JSON.stringify({ secured }) }), ctx({}));
    const refused = await put(true);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.details).toEqual({ reason: "email_required" });

    await m.db.db.update(S().customers).set({ emailVerifiedAt: new Date() }).where(eq(S().customers.id, c.id));
    expect(await (await put(true)).json()).toEqual({ secured: true });
    expect((await (await meRoute.GET(req("/api/v1/me", { headers: auth }), ctx({}))).json()).secured).toBe(true);
    const r = await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) });
    expect(r).toMatchObject({ stepUp: "email", reason: "secured", emailHint: "j•••@secure.test" });
    expect("accessToken" in r).toBe(false);
    if (!("stepUp" in r)) throw new Error("expected step-up");
    const sent = await m.auth.startStepUp(r.selectionToken);
    expect((await m.auth.verifyStepUp(r.selectionToken, sent.devCode!)).customer.id).toBe(c.id);

    expect(await (await put(false)).json()).toEqual({ secured: false });
    expect("accessToken" in (await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) }))).toBe(true);
    const audits = await m.db.db.select().from(S().auditLog).where(eq(S().auditLog.entityId, c.id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["customer.secured", "customer.unsecured"]));
  });

  it("a young child's profile on the parent's phone becomes a dependent; anything else goes to the shop", async () => {
    const p = phone();
    const parent = await m.customers.findOrCreateCustomer({ firstName: "Kara", lastName: "Lee", phone: p }, null);
    const kid = await m.customers.findOrCreateCustomer({ firstName: "Liam", lastName: "Lee", phone: p }, null);
    const teen = await m.customers.findOrCreateCustomer({ firstName: "Mia", lastName: "Lee", phone: p }, null);
    const year = Number(m.time.todayLocal().slice(0, 4));
    await m.db.db
      .update(S().customers)
      .set({ birthday: `${year - 8}-02-01` })
      .where(eq(S().customers.id, kid.id));
    await m.db.db
      .update(S().customers)
      .set({ birthday: `${year - 15}-02-01` })
      .where(eq(S().customers.id, teen.id));
    const auth = await bearer(parent.id);
    const claim = (body: object) => claimRoute.POST(req("/api/v1/me/family/claim", { method: "POST", headers: auth, body: JSON.stringify(body) }), ctx({}));

    expect((await claim({ firstName: "Nobody" })).status).toBe(404);
    expect(await (await claim({ firstName: " liam " })).json()).toEqual({ status: "converted", childId: kid.id });
    expect(await row(kid.id)).toMatchObject({ guardianId: parent.id, phone: null, lastName: null, birthday: null, birthYear: year - 8 });

    expect(await (await claim({ firstName: "Mia", birthYear: year - 15 })).json()).toEqual({ status: "requested" });
    expect((await row(teen.id)).guardianId).toBeNull();
    const [help] = await m.db.db
      .select()
      .from(S().identityHelpRequests)
      .where(and(eq(S().identityHelpRequests.phone, p), eq(S().identityHelpRequests.reason, "child_claim")));
    expect(help).toMatchObject({ firstName: "Mia", candidateIds: [parent.id, teen.id], message: `Parent says born ${year - 15}` });
  });
});

describe("App Review sign-in (C18 scaffold, not approved)", () => {
  const REVIEW_PHONE = "+13198889999";
  const on = () => Object.assign(process.env, { FEATURE_REVIEW_LOGIN: "true", APP_REVIEW_PHONE: REVIEW_PHONE, APP_REVIEW_CODE: "135790", APP_REVIEW_SHOP: "coralville" });

  it("is off by default: the number gets an ordinary code and the fixed one doesn't work", async () => {
    expect((await (await configRoute.GET(req("/api/v1/app/config"), ctx({}))).json()).accounts).toMatchObject({ minimumAge: 13, guestBooking: "web_only", reviewSignIn: false });
    const s = await m.auth.startOtp({ phone: REVIEW_PHONE });
    expect(s.devCode).toBeTruthy();
    if (s.devCode !== "135790") await expect(m.auth.verifyOtp({ phone: REVIEW_PHONE, code: "135790" })).rejects.toMatchObject({ code: "unauthorized" });
    process.env.FEATURE_REVIEW_LOGIN = "true";
    expect((await (await configRoute.GET(req("/api/v1/app/config"), ctx({}))).json()).accounts.reviewSignIn).toBe(false);
  });

  it("when switched on: the fixed code signs in to a sandbox profile, books only at the review shop and notifies nobody, all audited", async () => {
    on();
    expect((await (await configRoute.GET(req("/api/v1/app/config"), ctx({}))).json()).accounts.reviewSignIn).toBe(true);
    const s = await m.auth.startOtp({ phone: REVIEW_PHONE });
    expect(s).not.toHaveProperty("devCode");
    const r = await m.auth.verifyOtp({ phone: REVIEW_PHONE, code: "135790" });
    if (!("accessToken" in r)) throw new Error("expected tokens");
    expect(r.customer).toMatchObject({ firstName: "App", lastName: "Review", source: "App Review" });
    const auth = { authorization: `Bearer ${r.accessToken}` };

    const moline = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, "moline") }))!;
    const svc = (await m.catalog.shopCatalog(moline.id, { onlineOnly: true })).find((x) => x.kind === "service")!;
    const away = await apptRoute.POST(
      req("/api/v1/appointments", { method: "POST", headers: auth, body: JSON.stringify({ shopId: "moline", serviceId: svc.id, startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }) }),
      ctx({}),
    );
    expect(away.status).toBe(403);
    expect((await away.json()).error.details).toEqual({ reason: "review_account" });

    const res = await book(null, auth);
    expect(res.status).toBe(201);
    const a = await apptByCode((await res.json()).appointment.code);
    expect(await m.db.db.select().from(S().notificationJobs).where(eq(S().notificationJobs.appointmentId, a.id))).toEqual([]);

    const actions = (await m.db.db.select().from(S().auditLog).where(eq(S().auditLog.actorLabel, "review"))).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["review.sign_in", "review.booking"]));
    const codes = await m.db.db
      .select()
      .from(S().auditLog)
      .where(and(eq(S().auditLog.action, "review.sign_in_code"), eq(S().auditLog.entityId, REVIEW_PHONE)));
    expect(codes.length).toBeGreaterThan(0);

    process.env.STRIPE_SECRET_KEY = "sk_live_placeholder";
    const { assertReviewCanPay } = await import("@/server/auth/review-login");
    await expect(assertReviewCanPay(r.customer.id)).rejects.toMatchObject({ details: { reason: "review_account" } });
  });
});
