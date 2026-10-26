import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("demo mode", () => {
  it("never charges a live card: a live Stripe key is ignored and the simulator runs", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_123");
    const { paymentsMode } = await import("@/server/payments/processor");
    expect(paymentsMode()).toBe("simulator");
  });

  it("keeps a Stripe test key", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    const { paymentsMode } = await import("@/server/payments/processor");
    expect(paymentsMode()).toBe("stripe");
  });

  it("sends no texts, emails or calls, whatever provider is configured", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NOTIFICATIONS_SMS_PROVIDER", "console");
    vi.stubEnv("NOTIFICATIONS_EMAIL_PROVIDER", "console");
    vi.stubEnv("NOTIFICATIONS_VOICE_PROVIDER", "console");
    const p = await import("@/server/notifications/providers");
    expect([p.smsProvider().enabled, p.emailProvider().enabled, p.voiceProvider().enabled]).toEqual([false, false, false]);
  });

  it("shows customer sign-in codes even in a production build, and only in demo mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DEV_CODES", "true");
    const { devCodesEnabled } = await import("@/server/auth/customer");
    expect(devCodesEnabled()).toBe(false);
    vi.stubEnv("DEMO_MODE", "true");
    expect(devCodesEnabled()).toBe(true);
  });
});

describe("appBaseUrl", () => {
  it("prefers APP_BASE_URL, then the Vercel production URL, then localhost", async () => {
    const { appBaseUrl } = await import("@/lib/deployment");
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("VERCEL_URL", "");
    expect(appBaseUrl()).toBe("http://localhost:3000");
    vi.stubEnv("VERCEL_URL", "rayz-git-abc.vercel.app");
    expect(appBaseUrl()).toBe("https://rayz-git-abc.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "rayz.vercel.app");
    expect(appBaseUrl()).toBe("https://rayz.vercel.app");
    vi.stubEnv("APP_BASE_URL", "https://book.rayz.test/");
    expect(appBaseUrl()).toBe("https://book.rayz.test");
  });
});

describe("demo mode can't run in production", () => {
  it("stops on APP_ENV=production, a live Stripe key or a real provider, and lets the hosted demo start", async () => {
    const { assertDemoModeAllowed, productionSignals } = await import("@/lib/deployment");
    const demo = { DEMO_MODE: "true", VERCEL_ENV: "production", NODE_ENV: "production", NOTIFICATIONS_SMS_PROVIDER: "simulator", STRIPE_SECRET_KEY: "sk_test_1" };
    expect(() => assertDemoModeAllowed(demo)).not.toThrow();
    expect(productionSignals(demo)).toEqual([]);
    expect(() => assertDemoModeAllowed({ ...demo, APP_ENV: "production" })).toThrow(/DEMO_MODE=true can't run in production \(APP_ENV=production\)/);
    expect(() => assertDemoModeAllowed({ ...demo, STRIPE_SECRET_KEY: "sk_live_1" })).toThrow(/live STRIPE_SECRET_KEY/);
    expect(() => assertDemoModeAllowed({ ...demo, STRIPE_SECRET_KEY: "rk_live_1" })).toThrow(/live STRIPE_SECRET_KEY/);
    expect(() => assertDemoModeAllowed({ ...demo, NOTIFICATIONS_SMS_PROVIDER: "twilio" })).toThrow(/NOTIFICATIONS_SMS_PROVIDER=twilio/);
    expect(() => assertDemoModeAllowed({ ...demo, NOTIFICATIONS_EMAIL_PROVIDER: "Resend" })).toThrow(/NOTIFICATIONS_EMAIL_PROVIDER=resend/);
    expect(() => assertDemoModeAllowed({ APP_ENV: "production", STRIPE_SECRET_KEY: "sk_live_1" })).not.toThrow();
  });

  it("is checked when the server starts", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("APP_ENV", "production");
    const { register } = await import("@/instrumentation");
    await expect(register()).rejects.toThrow(/can't run in production/);
  });
});

describe("CORS", () => {
  it("answers only the app's own origin, CORS_ORIGINS and localhost in development; native apps send no Origin", async () => {
    vi.stubEnv("APP_BASE_URL", "https://book.rayz.test");
    const { allowedOrigin } = await import("@/server/api");
    const prod = { NODE_ENV: "production", CORS_ORIGINS: "https://rayzbarbershop.com, https://www.rayzbarbershop.com/" };
    expect(allowedOrigin("https://book.rayz.test", prod)).toBe("https://book.rayz.test");
    expect(allowedOrigin("https://www.rayzbarbershop.com", prod)).toBe("https://www.rayzbarbershop.com");
    expect(allowedOrigin("https://evil.example", prod)).toBeNull();
    expect(allowedOrigin("https://book.rayz.test.evil.example", prod)).toBeNull();
    expect(allowedOrigin("http://localhost:3000", prod)).toBeNull();
    expect(allowedOrigin("http://localhost:3000", { NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(allowedOrigin("null", prod)).toBeNull();
    expect(allowedOrigin(null, prod)).toBeNull();
  });

  it("puts the headers on allowed responses and preflights only, never a wildcard", async () => {
    vi.stubEnv("APP_BASE_URL", "https://book.rayz.test");
    vi.stubEnv("NODE_ENV", "production");
    const { json, options, route } = await import("@/server/api");
    const handler = route(async () => json({ ok: true }));
    const call = (origin?: string) => handler(new Request("https://book.rayz.test/api/v1/x", { headers: origin ? { origin } : {} }), { params: Promise.resolve({}) });
    const mine = await call("https://book.rayz.test");
    expect(mine.headers.get("Access-Control-Allow-Origin")).toBe("https://book.rayz.test");
    expect(mine.headers.get("Vary")).toMatch(/Origin/);
    const other = await call("https://evil.example");
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await call()).status).toBe(200);
    const pre = options(new Request("https://book.rayz.test/api/v1/x", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(pre.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });
});
