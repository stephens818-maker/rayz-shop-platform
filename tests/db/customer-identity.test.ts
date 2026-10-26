/**
 * Who a sign-in code lets in (C1, C13, C17, C21) and the app kill switches (C12): a phone code never
 * lists the profiles on the number; a number idle 18 months needs the profile's verified email, or
 * goes to the shop; an imported profile confirms it's theirs before rewards show; only a verified
 * email signs in, and a new one is saved only once its code is entered; codes are limited per IP.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let meRoute: typeof import("@/app/api/v1/me/route");
let loyaltyRoute: typeof import("@/app/api/v1/me/loyalty/route");
let configRoute: typeof import("@/app/api/v1/app/config/route");
let apptRoute: typeof import("@/app/api/v1/appointments/route");
let verifyRoute: typeof import("@/app/api/v1/auth/otp/verify/route");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

let n = 0;
const phone = () => `+1319777${String(1000 + ++n).padStart(4, "0")}`;
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <P,>(params: P) => ({ params: Promise.resolve(params) });
const old = () => new Date(Date.now() - 600 * 86_400_000);

async function codeFor(p: { phone?: string; email?: string }) {
  const s = await m.auth.startOtp(p);
  return s.devCode!;
}

beforeAll(async () => {
  m = await loadModules();
  process.env.AUTH_DEV_CODES = "true";
  meRoute = await import("@/app/api/v1/me/route");
  loyaltyRoute = await import("@/app/api/v1/me/loyalty/route");
  configRoute = await import("@/app/api/v1/app/config/route");
  apptRoute = await import("@/app/api/v1/appointments/route");
  verifyRoute = await import("@/app/api/v1/auth/otp/verify/route");
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["OTP_SMS_PROVIDER", "TWILIO_VERIFY_SERVICE_SID", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "APP_KILL"]) delete process.env[k];
});

afterAll(async () => {
  await m.db.db.update(m.schema.brandSettings).set({ appSwitches: {} });
});

describe("phone sign-in (C21)", () => {
  it("one adult on the number signs straight in; a family on it is asked for a name, never shown", async () => {
    const p = phone();
    const solo = await m.customers.findOrCreateCustomer({ firstName: "Tess", lastName: "Arden", phone: p }, null);
    const r = await (await verifyRoute.POST(req("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone: p, code: await codeFor({ phone: p }) }) }), ctx({}))).json();
    expect(r).toMatchObject({ needsProfile: false, isNew: false, identityCheckRequired: false, customer: { id: solo.id, emailVerified: false } });

    await m.customers.findOrCreateCustomer({ firstName: "Ugo", lastName: "Arden", phone: p }, null);
    const shared = await (await verifyRoute.POST(req("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone: p, code: await codeFor({ phone: p }) }) }), ctx({}))).json();
    expect(Object.keys(shared).sort()).toEqual(["needsProfile", "selectionToken"]);
    expect(JSON.stringify(shared)).not.toMatch(/Tess|Ugo|Arden/);
  });

  it("a number idle 18 months needs a code to the profile's verified email", async () => {
    const p = phone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Vic", phone: p }, null);
    await m.db.db.update(m.schema.customers).set({ createdAt: old(), email: "vic@fixture.test", emailVerifiedAt: old() }).where(eq(m.schema.customers.id, c.id));
    const r = await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) });
    expect(r).toMatchObject({ needsProfile: false, stepUp: "email", emailHint: "v•••@fixture.test" });
    if (!("stepUp" in r)) throw new Error("expected step-up");
    expect("accessToken" in r).toBe(false);

    const sent = await m.auth.startStepUp(r.selectionToken);
    await expect(m.auth.verifyStepUp(r.selectionToken, "000000" === sent.devCode ? "111111" : "000000")).rejects.toMatchObject({ code: "unauthorized" });
    const done = await m.auth.verifyStepUp(r.selectionToken, sent.devCode!);
    expect(done.customer.id).toBe(c.id);
    // Signing in counts as activity, so the next code goes straight through.
    const again = await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) });
    expect("accessToken" in again).toBe(true);
  });

  it("an idle number with no verified email can't sign in, and its help request reaches staff with the profile", async () => {
    const p = phone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Wren", phone: p, email: "wren@fixture.test" }, null);
    await m.db.db.update(m.schema.customers).set({ createdAt: old() }).where(eq(m.schema.customers.id, c.id));
    const r = await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) });
    expect(r).toMatchObject({ cantSignIn: true, reason: "idle_number" });
    if (!("cantSignIn" in r)) throw new Error("expected cantSignIn");
    await expect(m.auth.startStepUp(r.selectionToken)).rejects.toMatchObject({ code: "forbidden" });
    await m.auth.requestSignInHelp({ selectionToken: r.selectionToken, firstName: "Wren", lastName: "New", message: "new number since 2025" });
    const [help] = await m.db.db.select().from(m.schema.identityHelpRequests).where(eq(m.schema.identityHelpRequests.phone, p));
    expect(help).toMatchObject({ reason: "idle_number", status: "open", candidateIds: [c.id], firstName: "Wren" });
  });

  it("an imported profile confirms it's theirs before rewards show; five misses lock it and open a staff task", async () => {
    const p = phone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Xena", lastName: "Holt", phone: p }, null);
    await m.db.db.update(m.schema.customers).set({ source: "Squire import" }).where(eq(m.schema.customers.id, c.id));
    const r = await m.auth.verifyOtp({ phone: p, code: await codeFor({ phone: p }) });
    if (!("accessToken" in r)) throw new Error("expected tokens");
    expect(r.identityCheckRequired).toBe(true);
    const auth = { authorization: `Bearer ${r.accessToken}` };
    const loyalty = await (await loyaltyRoute.GET(req("/api/v1/me/loyalty", { headers: auth }), ctx({}))).json();
    expect(loyalty).toMatchObject({ redemptionLocked: true, rewards: [], availableCents: 0 });

    await expect(m.auth.checkIdentity(c.id, { lastName: "Wrong" })).rejects.toMatchObject({ code: "unauthorized", details: { attemptsLeft: 4 } });
    await m.auth.checkIdentity(c.id, { lastName: " holt " });
    const me = await (await meRoute.GET(req("/api/v1/me", { headers: auth }), ctx({}))).json();
    expect(me.identityCheckRequired).toBe(false);
    expect((await (await loyaltyRoute.GET(req("/api/v1/me/loyalty", { headers: auth }), ctx({}))).json()).redemptionLocked).toBe(false);

    const q = phone();
    const d = await m.customers.findOrCreateCustomer({ firstName: "Yael", lastName: "Stone", phone: q }, null);
    await m.db.db.update(m.schema.customers).set({ source: "Squire import" }).where(eq(m.schema.customers.id, d.id));
    for (let i = 0; i < 4; i++) await expect(m.auth.checkIdentity(d.id, { lastShop: "nowhere" })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(m.auth.checkIdentity(d.id, { lastName: "Stone-wrong" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.auth.checkIdentity(d.id, { lastName: "Stone" })).rejects.toMatchObject({ code: "forbidden" });
    const [task] = await m.db.db.select().from(m.schema.identityHelpRequests).where(eq(m.schema.identityHelpRequests.phone, q));
    expect(task).toMatchObject({ reason: "identity_check", candidateIds: [d.id] });
  });
});

describe("email (C17)", () => {
  it("an unverified email never signs in to the profile it's on", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Zane", phone: phone(), email: "zane.unverified@fixture.test" }, null);
    const r = await m.auth.verifyOtp({ email: "zane.unverified@fixture.test", code: await codeFor({ email: "zane.unverified@fixture.test" }) });
    expect(r).toMatchObject({ needsProfile: true });
    if (!("selectionToken" in r)) throw new Error("expected selection");
    const made = await m.auth.completeSignIn({ selectionToken: r.selectionToken, firstName: "Zane" });
    if (!("accessToken" in made)) throw new Error("expected tokens");
    expect(made.customer.id).not.toBe(c.id);
    expect(made.isNew).toBe(true);
  });

  it("a new email is saved, verified, only after its code; PATCH /me can't change it", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Abe", phone: phone() }, null);
    const { accessToken } = await m.auth.issueTokens(c.id, null);
    const auth = { authorization: `Bearer ${accessToken}` };
    const patch = await meRoute.PATCH(req("/api/v1/me", { method: "PATCH", headers: auth, body: JSON.stringify({ email: "abe@fixture.test" }) }), ctx({}));
    expect(patch.status).toBe(400);

    const sent = await m.auth.startEmailChange(c.id, "Abe@Fixture.test");
    await expect(m.auth.verifyEmailChange(c.id, "other@fixture.test", sent.devCode!)).rejects.toMatchObject({ code: "unauthorized" });
    const before = await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, c.id) });
    expect(before?.email).toBeNull();
    await m.auth.verifyEmailChange(c.id, "abe@fixture.test", sent.devCode!);
    const me = await (await meRoute.GET(req("/api/v1/me", { headers: auth }), ctx({}))).json();
    expect(me).toMatchObject({ email: "abe@fixture.test", emailVerified: true });

    // Now it signs in.
    const r = await m.auth.verifyOtp({ email: "abe@fixture.test", code: await codeFor({ email: "abe@fixture.test" }) });
    expect("accessToken" in r && r.customer.id).toBe(c.id);
    // Removing it is still a PATCH.
    const cleared = await (await meRoute.PATCH(req("/api/v1/me", { method: "PATCH", headers: auth, body: JSON.stringify({ email: null }) }), ctx({}))).json();
    expect(cleared).toMatchObject({ email: null, emailVerified: false });
  });
});

describe("codes and limits (C1, C13)", () => {
  it("limits codes per network", async () => {
    await m.db.db.delete(m.schema.apiRateEvents).where(eq(m.schema.apiRateEvents.bucket, "test_ip"));
    for (let i = 0; i < 20; i++) await m.rateLimit.rateLimit("test_ip", "203.0.113.9", 20, 3_600_000);
    await expect(m.rateLimit.rateLimit("test_ip", "203.0.113.9", 20, 3_600_000)).rejects.toMatchObject({ code: "rate_limited", details: { retryAfterSeconds: 3600 } });
    await m.rateLimit.rateLimit("test_ip", "203.0.113.10", 20, 3_600_000);
    await m.rateLimit.rateLimit("test_ip", null, 20, 3_600_000);
  });

  it("texts go through Twilio Verify, with the Android app hash, when it's configured", async () => {
    Object.assign(process.env, { OTP_SMS_PROVIDER: "twilio_verify", TWILIO_VERIFY_SERVICE_SID: "VA_test", TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "test" });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        const approved = new URLSearchParams(String(init.body)).get("Code") === "424242";
        return new Response(JSON.stringify(url.endsWith("VerificationCheck") ? { status: approved ? "approved" : "pending" } : { status: "pending" }), { status: 201 });
      }),
    );
    const p = phone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Bea", phone: p }, null);
    const s = await m.auth.startOtp({ phone: p, appHash: "FA+9qCX9VSu" });
    expect(s).not.toHaveProperty("devCode");
    expect(calls[0].url).toBe("https://verify.twilio.com/v2/Services/VA_test/Verifications");
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ To: p, Channel: "sms", AppHash: "FA+9qCX9VSu" });
    await expect(m.auth.verifyOtp({ phone: p, code: "111111" })).rejects.toMatchObject({ code: "unauthorized" });
    const r = await m.auth.verifyOtp({ phone: p, code: "424242" });
    expect("accessToken" in r && r.customer.id).toBe(c.id);
  });
});

describe("kill switches (C12)", () => {
  it("booking off refuses new bookings and shows in /app/config; APP_KILL does the same from env", async () => {
    await m.db.db.update(m.schema.brandSettings).set({ appSwitches: { booking: false } });
    const cfg = await (await configRoute.GET(req("/api/v1/app/config"), ctx({}))).json();
    expect(cfg.features).toEqual({ booking: false, payments: true, family: true, pushMarketing: true });
    const res = await apptRoute.POST(req("/api/v1/appointments", { method: "POST", body: JSON.stringify({}) }), ctx({}));
    expect(res.status).toBe(403);
    expect((await res.json()).error.details).toEqual({ switch: "booking" });

    await m.db.db.update(m.schema.brandSettings).set({ appSwitches: {} });
    process.env.APP_KILL = "payments, pushMarketing";
    expect((await (await configRoute.GET(req("/api/v1/app/config"), ctx({}))).json()).features).toEqual({ booking: true, payments: false, family: true, pushMarketing: false });
  });

  it("family off refuses the app's family endpoints; the website's account page keeps working", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Fay", phone: phone() }, null);
    const auth = { authorization: `Bearer ${(await m.auth.issueTokens(c.id, null)).accessToken}` };
    const v1 = await import("@/app/api/v1/me/family/route");
    const claim = await import("@/app/api/v1/me/family/claim/route");
    const web = await import("@/app/api/account/family/route");
    expect((await v1.GET(req("/api/v1/me/family", { headers: auth }), ctx({}))).status).toBe(200);
    process.env.APP_KILL = "family";
    const off = await v1.GET(req("/api/v1/me/family", { headers: auth }), ctx({}));
    expect(off.status).toBe(403);
    expect((await off.json()).error.details).toEqual({ switch: "family" });
    expect((await claim.POST(req("/api/v1/me/family/claim", { method: "POST", headers: auth, body: JSON.stringify({ firstName: "Kid" }) }), ctx({}))).status).toBe(403);
    expect((await web.GET(req("/api/account/family", { headers: auth }), ctx({}))).status).toBe(200);
  });
});
