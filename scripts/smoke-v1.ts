/**
 * Release checklist for /api/v1.
 *
 *   pnpm smoke:v1
 *
 * Uses DATABASE_URL (defaults from .env). Stripe live keys fail the run.
 * A sk_test_ key confirms a $0.50 PaymentIntent on pm_card_visa and refunds it.
 * With no key, the built-in simulator handles the same chargeCard call.
 * Twilio is contacted only when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and
 * TWILIO_VERIFY_SERVICE_SID are set: the script reads the Verify service and does not text anyone.
 * Set TWILIO_SMOKE_TO=+15005550006 to also start Verify against Twilio's magic test number.
 *
 * The walk calls the route handlers in-process. It does not book a customer or send a message
 * unless the magic number above is set. Customer booking before LAUNCH_AT is asserted closed.
 */
import "dotenv/config";
import { addDays, todayLocal } from "@/lib/time";
import { closeDb } from "@/db";
import { AppError } from "@/server/errors";
import { assertLaunched, launchState } from "@/server/launch";
import { assertStripeTestMode, chargeCard, stripe } from "@/server/payments/processor";
import { smsProvider } from "@/server/notifications/providers";
import { twilioVerifyConfigured } from "@/server/mobile/verify";

const MAGIC_TO = "+15005550006";

type Outcome = { name: string; status: "pass" | "skip" | "fail"; detail?: string };
const results: Outcome[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, status: "pass", detail });
}
function skip(name: string, detail: string) {
  results.push({ name, status: "skip", detail });
}
function fail(name: string, detail: string) {
  results.push({ name, status: "fail", detail });
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function asRoute(mod: object): { GET?: Handler; POST?: Handler } {
  return mod as { GET?: Handler; POST?: Handler };
}

async function call(mod: object, method: "GET" | "POST", url: string, params: Record<string, string> = {}, init: RequestInit = {}) {
  const handler = asRoute(mod)[method];
  if (!handler) throw new Error(`No ${method} handler`);
  return handler(new Request(url, { method, ...init }), { params: Promise.resolve(params) });
}

async function expectStatus(name: string, res: Response, ok: (status: number) => boolean) {
  const text = await res.text();
  if (!ok(res.status)) fail(name, `${res.status} ${text.slice(0, 240)}`);
  else pass(name, String(res.status));
  return text;
}

async function stripeCheck() {
  try {
    assertStripeTestMode();
  } catch (e) {
    fail("stripe test mode", e instanceof Error ? e.message : String(e));
    return;
  }
  pass("stripe test mode", "live keys refused");
  const client = stripe();
  if (!client) {
    const sim = await chargeCard({
      paymentMethodId: "pm_card_visa",
      amountCents: 50,
      description: "smoke simulator",
      metadata: { smoke: "v1" },
      idempotencyKey: `smoke-sim-${Date.now()}`,
    });
    if (sim.processor !== "simulator") fail("stripe simulator charge", sim.processor);
    else pass("stripe simulator charge", sim.paymentIntentId);
    return;
  }
  const pi = await client.paymentIntents.create({
    amount: 50,
    currency: "usd",
    payment_method: "pm_card_visa",
    confirm: true,
    description: "rayz smoke",
    metadata: { smoke: "v1" },
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  });
  if (pi.status === "succeeded") {
    const refund = await client.refunds.create({ payment_intent: pi.id });
    if (refund.status === "failed") fail("stripe test PaymentIntent", "refund failed");
    else pass("stripe test PaymentIntent", `${pi.id} refunded`);
    return;
  }
  if (pi.status === "requires_capture" || pi.status === "requires_confirmation" || pi.status === "requires_action") {
    const cancelled = await client.paymentIntents.cancel(pi.id);
    if (cancelled.status !== "canceled") fail("stripe test PaymentIntent", cancelled.status);
    else pass("stripe test PaymentIntent", `${pi.id} cancelled`);
    return;
  }
  fail("stripe test PaymentIntent", pi.status);
}

async function twilioCheck() {
  if (!twilioVerifyConfigured()) {
    skip("twilio verify", "set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID");
    return;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const service = process.env.TWILIO_VERIFY_SERVICE_SID!;
  const res = await fetch(`https://verify.twilio.com/v2/Services/${service}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
  });
  if (!res.ok) {
    fail("twilio verify service", `${res.status}`);
    return;
  }
  pass("twilio verify service", "credentials accepted");
  const to = process.env.TWILIO_SMOKE_TO?.trim();
  if (!to) {
    skip("twilio verify send", `set TWILIO_SMOKE_TO=${MAGIC_TO} to start a check without texting a person`);
    return;
  }
  if (to !== MAGIC_TO) {
    fail("twilio verify send", `refusing to text ${to}. Only ${MAGIC_TO} is allowed.`);
    return;
  }
  const { startTwilioVerify } = await import("@/server/mobile/verify");
  try {
    const verifySid = await startTwilioVerify(to, "sms");
    pass("twilio verify send", verifySid);
  } catch (e) {
    fail("twilio verify send", e instanceof Error ? e.message : String(e));
  }
}

async function launchCheck() {
  const saved = process.env.LAUNCH_AT;
  try {
    process.env.LAUNCH_AT = "2999-01-01T00:00:00.000Z";
    const closed = await launchState();
    if (closed.launched) {
      fail("launch gate closed", JSON.stringify(closed));
      return;
    }
    let threw = false;
    try {
      await assertLaunched("booking");
    } catch (e) {
      threw = e instanceof AppError && e.code === "forbidden" && (e.details as { reason?: string })?.reason === "not_launched";
    }
    if (!threw) {
      fail("launch gate closed", "assertLaunched did not refuse");
      return;
    }
    process.env.LAUNCH_AT = "2000-01-01T00:00:00.000Z";
    await assertLaunched("payments");
    await assertLaunched("push");
    pass("launch gate", "future timestamp blocks customer surfaces; a past timestamp opens them");
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_AT;
    else process.env.LAUNCH_AT = saved;
  }
}

async function apiWalk() {
  if (!process.env.DATABASE_URL) {
    fail("api walk", "DATABASE_URL is not set");
    return;
  }
  const day = addDays(todayLocal(), 3);
  const shops = await import("@/app/api/v1/shops/route");
  const shop = await import("@/app/api/v1/shops/[shop]/route");
  const services = await import("@/app/api/v1/shops/[shop]/services/route");
  const barbers = await import("@/app/api/v1/shops/[shop]/barbers/route");
  const availability = await import("@/app/api/v1/shops/[shop]/availability/route");
  const days = await import("@/app/api/v1/shops/[shop]/available-days/route");
  const config = await import("@/app/api/v1/app/config/route");
  const spec = await import("@/app/api/v1/openapi.json/route");
  const me = await import("@/app/api/v1/me/route");
  const meAppts = await import("@/app/api/v1/me/appointments/route");
  const loyalty = await import("@/app/api/v1/me/loyalty/route");
  const devices = await import("@/app/api/v1/me/devices/route");
  const purchases = await import("@/app/api/v1/me/purchases/route");
  const receipt = await import("@/app/api/v1/me/purchases/receipt/route");
  const appt = await import("@/app/api/v1/appointments/route");
  const apptGet = await import("@/app/api/v1/appointments/[code]/route");
  const otp = await import("@/app/api/v1/auth/otp/start/route");
  const verify = await import("@/app/api/v1/auth/otp/verify/route");
  const refresh = await import("@/app/api/v1/auth/refresh/route");
  const logout = await import("@/app/api/v1/auth/logout/route");
  const onboard = await import("@/app/api/v1/internal/connect/onboard/route");

  const shopList = await call(shops, "GET", "http://localhost/api/v1/shops");
  const shopBody = await expectStatus("GET /shops", shopList, (s) => s === 200);
  if (shopList.status !== 200 || !shopBody.includes("coralville")) {
    fail("seed", "GET /shops did not include coralville. Run pnpm db:reset.");
    return;
  }
  pass("seed", "coralville");

  await expectStatus("GET /shops/coralville", await call(shop, "GET", "http://localhost/api/v1/shops/coralville", { shop: "coralville" }), (s) => s === 200);
  const svcRes = await call(services, "GET", "http://localhost/api/v1/shops/coralville/services", { shop: "coralville" });
  const svcText = await expectStatus("GET /shops/coralville/services", svcRes, (s) => s === 200);
  const svc = (JSON.parse(svcText) as { services?: { id: string }[] }).services?.[0];
  if (!svc) {
    fail("service id", "no services");
    return;
  }
  await expectStatus("GET /shops/coralville/barbers", await call(barbers, "GET", "http://localhost/api/v1/shops/coralville/barbers", { shop: "coralville" }), (s) => s === 200);
  const q = `date=${day}&serviceId=${svc.id}`;
  await expectStatus(
    "GET /shops/coralville/availability",
    await call(availability, "GET", `http://localhost/api/v1/shops/coralville/availability?${q}`, { shop: "coralville" }),
    (s) => s === 200,
  );
  await expectStatus(
    "GET /shops/coralville/available-days",
    await call(days, "GET", `http://localhost/api/v1/shops/coralville/available-days?from=${day}&serviceId=${svc.id}&days=7`, { shop: "coralville" }),
    (s) => s === 200,
  );

  const cfgRes = await call(config, "GET", "http://localhost/api/v1/app/config", {}, { headers: { "x-client": "ios", "x-app-version": "99.0.0" } });
  const cfgText = await expectStatus("GET /app/config", cfgRes, (s) => s === 200);
  if (cfgRes.status === 200) {
    const cfg = JSON.parse(cfgText) as Record<string, unknown>;
    const keys = ["minIos", "minAndroid", "latestIos", "latestAndroid", "iosStoreUrl", "androidStoreUrl", "flags", "timezone", "timeFormat", "launched", "launchAt", "pilot", "pilotShops", "closedShopCopy", "shops", "minVersion", "forceUpdateBelow"];
    const missing = keys.filter((k) => !(k in cfg));
    if (missing.length) fail("app config fields", missing.join(", "));
    else pass("app config fields", `launched=${String(cfg.launched)}`);
  }
  await expectStatus(
    "GET /app/config force update",
    await call(config, "GET", "http://localhost/api/v1/app/config", {}, { headers: { "x-client": "android", "x-app-version": "0.0.1" } }),
    (s) => s === 426,
  );

  const specRes = await call(spec, "GET", "http://localhost/api/v1/openapi.json");
  const specText = await expectStatus("GET /openapi.json", specRes, (s) => s === 200);
  if (specRes.status === 200) {
    const doc = JSON.parse(specText) as { info?: { version?: string }; paths?: Record<string, unknown> };
    if (doc.info?.version !== "1.0.0" || !doc.paths?.["/app/config"] || !doc.paths?.["/appointments"]) fail("openapi 1.0.0", doc.info?.version ?? "missing");
    else pass("openapi 1.0.0", `${Object.keys(doc.paths).length} paths`);
  }

  for (const [name, mod, url] of [
    ["GET /me", me, "http://localhost/api/v1/me"],
    ["GET /me/appointments", meAppts, "http://localhost/api/v1/me/appointments"],
    ["GET /me/loyalty", loyalty, "http://localhost/api/v1/me/loyalty"],
    ["GET /me/devices", devices, "http://localhost/api/v1/me/devices"],
    ["GET /me/purchases", purchases, "http://localhost/api/v1/me/purchases"],
    ["GET /me/purchases/receipt", receipt, "http://localhost/api/v1/me/purchases/receipt"],
  ] as const) {
    await expectStatus(name, await call(mod, "GET", url), (s) => s === 401);
  }

  await expectStatus(
    "GET /appointments/missing",
    await call(apptGet, "GET", "http://localhost/api/v1/appointments/missing-code", { code: "missing-code" }),
    (s) => s === 404,
  );
  await expectStatus(
    "POST /appointments empty",
    await call(appt, "POST", "http://localhost/api/v1/appointments", {}, { body: "{}", headers: { "content-type": "application/json" } }),
    (s) => s === 400,
  );
  await expectStatus(
    "POST /auth/otp/verify bad code",
    await call(verify, "POST", "http://localhost/api/v1/auth/otp/verify", {}, { body: JSON.stringify({ phone: "+13195550901", code: "000000" }), headers: { "content-type": "application/json" } }),
    (s) => s === 401,
  );
  await expectStatus(
    "POST /auth/refresh bad token",
    await call(refresh, "POST", "http://localhost/api/v1/auth/refresh", {}, { body: JSON.stringify({ refreshToken: "not-a-token" }), headers: { "content-type": "application/json" } }),
    (s) => s === 401,
  );
  await expectStatus(
    "POST /auth/logout unknown token",
    await call(logout, "POST", "http://localhost/api/v1/auth/logout", {}, { body: JSON.stringify({ refreshToken: "not-a-token" }), headers: { "content-type": "application/json" } }),
    (s) => s === 204,
  );
  await expectStatus(
    "POST /internal/connect/onboard",
    await call(onboard, "POST", "http://localhost/api/v1/internal/connect/onboard", {}, { body: JSON.stringify({ shop: "coralville" }), headers: { "content-type": "application/json" } }),
    (s) => s === 401,
  );

  const smsOn = smsProvider().enabled;
  if (twilioVerifyConfigured() && process.env.TWILIO_SMOKE_TO?.trim() === MAGIC_TO) {
    await expectStatus(
      "POST /auth/otp/start magic number",
      await call(otp, "POST", "http://localhost/api/v1/auth/otp/start", {}, { body: JSON.stringify({ phone: MAGIC_TO }), headers: { "content-type": "application/json" } }),
      (s) => s === 200,
    );
  } else if (twilioVerifyConfigured() || smsOn) {
    skip("POST /auth/otp/start", "skipped so this checklist does not text or email anyone");
  } else {
    await expectStatus(
      "POST /auth/otp/start local",
      await call(otp, "POST", "http://localhost/api/v1/auth/otp/start", {}, { body: JSON.stringify({ phone: "+13195550901" }), headers: { "content-type": "application/json" } }),
      (s) => s === 200,
    );
  }
}

async function main() {
  await stripeCheck();
  await twilioCheck();
  if (process.env.DATABASE_URL) await launchCheck();
  else skip("launch gate", "DATABASE_URL is not set");
  await apiWalk();
  const failed = results.filter((r) => r.status === "fail");
  for (const r of results) {
    const line = r.detail ? `${r.status.toUpperCase()} ${r.name} — ${r.detail}` : `${r.status.toUpperCase()} ${r.name}`;
    console.log(line);
  }
  await closeDb();
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n${results.length} checks, ${results.filter((r) => r.status === "skip").length} skipped.`);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => {});
  process.exit(1);
});
