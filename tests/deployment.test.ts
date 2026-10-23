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
