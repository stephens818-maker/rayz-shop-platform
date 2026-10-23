/**
 * Live /api/v1 responses must satisfy the zod schemas published in the OpenAPI document.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiSchemas } from "@/server/api-schemas";
import { signToken } from "@/server/auth/tokens";
import { openApiDocument } from "@/server/openapi";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
const doc = openApiDocument("https://rayzbs.com");

beforeAll(async () => {
  process.env.AUTH_DEV_CODES = "true";
  process.env.IMPORT_SECRET = "openapi-contract";
  m = await loadModules();
}, 180_000);

afterAll(async () => {
  delete process.env.AUTH_DEV_CODES;
  delete process.env.IMPORT_SECRET;
  await m?.db.closeDb();
});

const schemas = apiSchemas as Record<string, { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown } } }>;

function refsOf(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as { $ref?: string; oneOf?: unknown[] };
  if (node.$ref) return [node.$ref.split("/").pop()!];
  if (node.oneOf) return node.oneOf.flatMap(refsOf);
  return [];
}

function assertLive(path: string, method: string, status: number, body: unknown) {
  const op = (doc.paths as Record<string, Record<string, { responses: Record<string, { content?: { "application/json"?: { schema?: unknown } } }> }>>)[path]?.[method];
  const names = refsOf(op?.responses?.[String(status)]?.content?.["application/json"]?.schema);
  if (status === 204) {
    expect(names, `${method} ${path}`).toEqual([]);
    return;
  }
  expect(names.length, `${method} ${path} ${status}`).toBeGreaterThan(0);
  const attempts = names.map((name) => {
    const parsed = schemas[name].safeParse(body);
    return parsed.success ? null : { name, issues: parsed.error?.issues };
  });
  expect(attempts.some((row) => row === null), `${method} ${path} ${status}\n${JSON.stringify(attempts, null, 2)}\n${JSON.stringify(body).slice(0, 2000)}`).toBe(true);
}

function call(mod: { POST?: Function; GET?: Function; DELETE?: Function; PATCH?: Function }, method: "POST" | "GET" | "DELETE" | "PATCH", url: string, params: Record<string, string>, init: RequestInit = {}) {
  const handler = mod[method] as (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  return handler(new Request(url, { ...init, method }), { params: Promise.resolve(params) });
}

async function jsonOf(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("OpenAPI schemas match live /api/v1 responses", () => {
  it("parses each operation's live JSON with the schema named in the spec", async () => {
    const authHeaders = async (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

    const config = await jsonOf(await call(await import("@/app/api/v1/app/config/route"), "GET", "http://localhost/api/v1/app/config", {}));
    expect(config.status).toBe(200);
    assertLive("/app/config", "get", 200, config.body);

    const shops = await jsonOf(await call(await import("@/app/api/v1/shops/route"), "GET", "http://localhost/api/v1/shops", {}));
    assertLive("/shops", "get", 200, shops.body);
    const shop = await jsonOf(await call(await import("@/app/api/v1/shops/[shop]/route"), "GET", "http://localhost/api/v1/shops/coralville", { shop: "coralville" }));
    assertLive("/shops/{shop}", "get", 200, shop.body);
    const services = await jsonOf(await call(await import("@/app/api/v1/shops/[shop]/services/route"), "GET", "http://localhost/api/v1/shops/coralville/services", { shop: "coralville" }));
    assertLive("/shops/{shop}/services", "get", 200, services.body);
    const barbers = await jsonOf(await call(await import("@/app/api/v1/shops/[shop]/barbers/route"), "GET", "http://localhost/api/v1/shops/coralville/barbers", { shop: "coralville" }));
    assertLive("/shops/{shop}/barbers", "get", 200, barbers.body);
    const live = await jsonOf(await call(await import("@/app/api/v1/shops/[shop]/live/route"), "GET", "http://localhost/api/v1/shops/coralville/live", { shop: "coralville" }));
    assertLive("/shops/{shop}/live", "get", 200, live.body);

    const cut = services.body.services.find((row: { slug: string }) => row.slug === "rayz-cut");
    let slot: { startsAt: string; barberIds: string[] } | undefined;
    let date = "";
    for (let i = 4; i < 21 && !slot; i++) {
      date = m.time.addDays(m.time.todayLocal(), i);
      const day = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: cut.id, barberRef: "any" });
      slot = day.slots.at(-1);
    }
    if (!slot) throw new Error("no slots");
    const availability = await jsonOf(
      await call(await import("@/app/api/v1/shops/[shop]/availability/route"), "GET", `http://localhost/api/v1/shops/coralville/availability?date=${date}&serviceId=${cut.id}`, { shop: "coralville" }),
    );
    assertLive("/shops/{shop}/availability", "get", 200, availability.body);
    const days = await jsonOf(
      await call(await import("@/app/api/v1/shops/[shop]/available-days/route"), "GET", `http://localhost/api/v1/shops/coralville/available-days?from=${date}&days=3&serviceId=${cut.id}`, { shop: "coralville" }),
    );
    assertLive("/shops/{shop}/available-days", "get", 200, days.body);

    const booked = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: cut.id,
      barberRef: slot.barberIds[0],
      startsAt: slot.startsAt,
      customer: { firstName: "Nora", lastName: "Schema", phone: "3195550198" },
      source: "api",
      actor,
    });
    const customerId = booked.customer!.id;
    const tokens = await m.auth.issueTokens(customerId, null);
    const auth = await authHeaders(tokens.accessToken);

    let createdSlot = slot;
    for (let i = 4; i < 21; i++) {
      const day = await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(m.time.todayLocal(), i), serviceId: cut.id, barberRef: "any" });
      const other = day.slots.find((row) => row.startsAt !== slot!.startsAt);
      if (other) {
        createdSlot = other;
        break;
      }
    }
    const created = await jsonOf(
      await call(await import("@/app/api/v1/appointments/route"), "POST", "http://localhost/api/v1/appointments", {}, {
        headers: { ...auth, "idempotency-key": "openapi-book" },
        body: JSON.stringify({ shopId: "coralville", serviceId: cut.id, barberId: createdSlot.barberIds[0], startsAt: createdSlot.startsAt }),
      }),
    );
    expect(created.status).toBe(201);
    assertLive("/appointments", "post", 201, created.body);

    const got = await jsonOf(await call(await import("@/app/api/v1/appointments/[code]/route"), "GET", `http://localhost/api/v1/appointments/${booked.code}`, { code: booked.code }));
    assertLive("/appointments/{code}", "get", 200, got.body);

    const me = await jsonOf(await call(await import("@/app/api/v1/me/route"), "GET", "http://localhost/api/v1/me", {}, { headers: auth }));
    assertLive("/me", "get", 200, me.body);
    const patched = await jsonOf(
      await call(await import("@/app/api/v1/me/route"), "PATCH", "http://localhost/api/v1/me", {}, {
        headers: auth,
        body: JSON.stringify({ smsOptIn: true, consentTextVersion: "openapi-1" }),
      }),
    );
    assertLive("/me", "patch", 200, patched.body);

    const appts = await jsonOf(await call(await import("@/app/api/v1/me/appointments/route"), "GET", "http://localhost/api/v1/me/appointments", {}, { headers: auth }));
    assertLive("/me/appointments", "get", 200, appts.body);
    const loyalty = await jsonOf(await call(await import("@/app/api/v1/me/loyalty/route"), "GET", "http://localhost/api/v1/me/loyalty", {}, { headers: auth }));
    assertLive("/me/loyalty", "get", 200, loyalty.body);
    const home = await jsonOf(await call(await import("@/app/api/v1/me/home/route"), "GET", "http://localhost/api/v1/me/home", {}, { headers: auth }));
    assertLive("/me/home", "get", 200, home.body);

    const otp = await jsonOf(
      await call(await import("@/app/api/v1/auth/otp/start/route"), "POST", "http://localhost/api/v1/auth/otp/start", {}, {
        body: JSON.stringify({ phone: "3195550197" }),
      }),
    );
    assertLive("/auth/otp/start", "post", 200, otp.body);
    const verified = await jsonOf(
      await call(await import("@/app/api/v1/auth/otp/verify/route"), "POST", "http://localhost/api/v1/auth/otp/verify", {}, {
        body: JSON.stringify({ phone: "3195550197", code: otp.body.devCode }),
      }),
    );
    assertLive("/auth/otp/verify", "post", 200, verified.body);

    const refreshed = await jsonOf(
      await call(await import("@/app/api/v1/auth/refresh/route"), "POST", "http://localhost/api/v1/auth/refresh", {}, {
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      }),
    );
    assertLive("/auth/refresh", "post", 200, refreshed.body);
    const loggedOut = await call(await import("@/app/api/v1/auth/logout/route"), "POST", "http://localhost/api/v1/auth/logout", {}, {
      body: JSON.stringify({ refreshToken: refreshed.body.refreshToken }),
    });
    expect(loggedOut.status).toBe(204);
    assertLive("/auth/logout", "post", 204, null);

    const registered = await jsonOf(
      await call(await import("@/app/api/v1/me/devices/route"), "POST", "http://localhost/api/v1/me/devices", {}, {
        headers: auth,
        body: JSON.stringify({ platform: "ios", provider: "apns", token: "openapi-device-token" }),
      }),
    );
    assertLive("/me/devices", "post", 201, registered.body);
    const devices = await jsonOf(await call(await import("@/app/api/v1/me/devices/route"), "GET", "http://localhost/api/v1/me/devices", {}, { headers: auth }));
    assertLive("/me/devices", "get", 200, devices.body);
    const revoked = await jsonOf(
      await call(await import("@/app/api/v1/me/devices/[id]/route"), "DELETE", `http://localhost/api/v1/me/devices/${registered.body.id}`, { id: registered.body.id }, { headers: auth }),
    );
    assertLive("/me/devices/{id}", "delete", 200, revoked.body);

    const family = await jsonOf(
      await call(await import("@/app/api/v1/me/family/route"), "POST", "http://localhost/api/v1/me/family", {}, {
        headers: auth,
        body: JSON.stringify({ firstName: "Kai", birthYear: 2015 }),
      }),
    );
    assertLive("/me/family", "post", 201, family.body);
    const members = await jsonOf(await call(await import("@/app/api/v1/me/family/route"), "GET", "http://localhost/api/v1/me/family", {}, { headers: auth }));
    assertLive("/me/family", "get", 200, members.body);
    const removed = await call(await import("@/app/api/v1/me/family/[id]/route"), "DELETE", `http://localhost/api/v1/me/family/${family.body.member.id}`, { id: family.body.member.id }, { headers: auth });
    expect(removed.status).toBe(204);

    const setup = await jsonOf(
      await call(await import("@/app/api/v1/me/payment-methods/setup/route"), "POST", "http://localhost/api/v1/me/payment-methods/setup", {}, {
        headers: auth,
        body: JSON.stringify({ funding: "credit" }),
      }),
    );
    assertLive("/me/payment-methods/setup", "post", 200, setup.body);
    const cards = await jsonOf(await call(await import("@/app/api/v1/me/payment-methods/route"), "GET", "http://localhost/api/v1/me/payment-methods", {}, { headers: auth }));
    assertLive("/me/payment-methods", "get", 200, cards.body);

    const preview = await jsonOf(
      await call(await import("@/app/api/v1/appointments/[code]/payment-preview/route"), "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-preview`, { code: booked.code }, {
        headers: auth,
        body: JSON.stringify({ paymentMethodId: setup.body.paymentMethod.id, tipCents: 500 }),
      }),
    );
    assertLive("/appointments/{code}/payment-preview", "post", 200, preview.body);
    const sheet = await jsonOf(
      await call(await import("@/app/api/v1/appointments/[code]/payment-intents/route"), "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-intents`, { code: booked.code }, {
        headers: auth,
        body: JSON.stringify({ paymentMethodId: setup.body.paymentMethod.id, tipCents: 500 }),
      }),
    );
    assertLive("/appointments/{code}/payment-intents", "post", 200, sheet.body);
    await m.processor.confirmPaymentIntent(sheet.body.id);
    const paid = await jsonOf(
      await call(await import("@/app/api/v1/appointments/[code]/payments/route"), "POST", `http://localhost/api/v1/appointments/${booked.code}/payments`, { code: booked.code }, {
        headers: { ...auth, "idempotency-key": "openapi-pay" },
        body: JSON.stringify({ paymentIntentId: sheet.body.id }),
      }),
    );
    assertLive("/appointments/{code}/payments", "post", 200, paid.body);

    const receipts = await jsonOf(await call(await import("@/app/api/v1/me/receipts/route"), "GET", "http://localhost/api/v1/me/receipts", {}, { headers: auth }));
    assertLive("/me/receipts", "get", 200, receipts.body);
    const receipt = await jsonOf(await call(await import("@/app/api/v1/me/receipts/[id]/route"), "GET", `http://localhost/api/v1/me/receipts/${paid.body.id}`, { id: paid.body.id }, { headers: auth }));
    assertLive("/me/receipts/{id}", "get", 200, receipt.body);
    const missing = await jsonOf(await call(await import("@/app/api/v1/me/receipts/[id]/route"), "GET", "http://localhost/api/v1/me/receipts/undefined", { id: "undefined" }, { headers: auth }));
    assertLive("/me/receipts/{id}", "get", 200, missing.body);

    const purchases = await jsonOf(await call(await import("@/app/api/v1/me/purchases/route"), "GET", "http://localhost/api/v1/me/purchases", {}, { headers: auth }));
    assertLive("/me/purchases", "get", 200, purchases.body);
    const text = await jsonOf(await call(await import("@/app/api/v1/me/purchases/receipt/route"), "GET", `http://localhost/api/v1/me/purchases/receipt?id=${paid.body.id}`, {}, { headers: auth }));
    assertLive("/me/purchases/receipt", "get", 200, text.body);
    expect(text.body.receipt.text).toContain("Credit card surcharge (3%)");

    const rebooked = await jsonOf(
      await call(await import("@/app/api/v1/appointments/[code]/rebook/route"), "POST", `http://localhost/api/v1/appointments/${booked.code}/rebook`, { code: booked.code }, { headers: auth }),
    );
    assertLive("/appointments/{code}/rebook", "post", 201, rebooked.body);

    const moved = await jsonOf(
      await call(await import("@/app/api/v1/appointments/[code]/reschedule/route"), "POST", `http://localhost/api/v1/appointments/${rebooked.body.appointment.code}/reschedule`, { code: rebooked.body.appointment.code }, {
        headers: auth,
        body: JSON.stringify({ startsAt: rebooked.body.appointment.startsAt }),
      }),
    );
    if (moved.status === 200) assertLive("/appointments/{code}/reschedule", "post", 200, moved.body);
    const cancelled = await jsonOf(
      await call(await import("@/app/api/v1/appointments/[code]/cancel/route"), "POST", `http://localhost/api/v1/appointments/${rebooked.body.appointment.code}/cancel`, { code: rebooked.body.appointment.code }, {
        headers: auth,
        body: JSON.stringify({ reason: "Plans changed" }),
      }),
    );
    assertLive("/appointments/{code}/cancel", "post", 200, cancelled.body);

    const staffConnect = await jsonOf(await call(await import("@/app/api/v1/staff/connect/route"), "GET", "http://localhost/api/v1/staff/connect", {}, { headers: auth }));
    assertLive("/staff/connect", "get", 200, staffConnect.body);
    const [barber] = await m.db.db
      .select()
      .from(m.schema.staff)
      .where(m.drizzle.and(m.drizzle.eq(m.schema.staff.firstName, "Makenna"), m.drizzle.eq(m.schema.staff.active, true)))
      .limit(1);
    const staffToken = await signToken({ sub: barber!.id }, "staff_session", 3600);
    const onboard = await jsonOf(
      await call(await import("@/app/api/v1/staff/connect/onboard/route"), "POST", "http://localhost/api/v1/staff/connect/onboard", {}, {
        headers: await authHeaders(staffToken),
        body: JSON.stringify({ shop: "coralville" }),
      }),
    );
    expect(onboard.status, JSON.stringify(onboard.body)).toBe(200);
    assertLive("/staff/connect/onboard", "post", 200, onboard.body);

    const internal = await jsonOf(
      await call(await import("@/app/api/v1/internal/connect/onboard/route"), "POST", "http://localhost/api/v1/internal/connect/onboard", {}, {
        headers: { "content-type": "application/json", "x-import-secret": "openapi-contract" },
        body: JSON.stringify({ shop: "coralville" }),
      }),
    );
    expect(internal.status, JSON.stringify(internal.body)).toBe(200);
    assertLive("/internal/connect/onboard", "post", 200, internal.body);

    const detach = await call(await import("@/app/api/v1/me/payment-methods/[id]/route"), "DELETE", `http://localhost/api/v1/me/payment-methods/${setup.body.paymentMethod.id}`, { id: setup.body.paymentMethod.id }, { headers: auth });
    expect(detach.status).toBe(204);

    const started = await jsonOf(await call(await import("@/app/api/v1/me/delete/start/route"), "POST", "http://localhost/api/v1/me/delete/start", {}, { headers: auth }));
    assertLive("/me/delete/start", "post", 200, started.body);
    const confirmed = await jsonOf(
      await call(await import("@/app/api/v1/me/delete/confirm/route"), "POST", "http://localhost/api/v1/me/delete/confirm", {}, {
        headers: auth,
        body: JSON.stringify({ code: started.body.devCode }),
      }),
    );
    assertLive("/me/delete/confirm", "post", 200, confirmed.body);
  });
});
