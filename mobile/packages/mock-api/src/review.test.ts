import { describe, expect, it } from "vitest";
import { createApp } from "./http";
import { SHOP_CORALVILLE, STAFF_KAT, STAFF_MAKENNA } from "./fixtures";
import { createWorld, type World } from "./world";

async function bodyOf(res: Response) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const ALEX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const JORDAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const auth = (id: string) => ({ authorization: `Bearer cust.${id}`, "content-type": "application/json" });

describe("review fixes and the customer contract", () => {
  it("drops last names and last initials, and refuses an arbitrary customer id", async () => {
    const app = createApp();
    const choice = await bodyOf(await app.request("/api/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+13195550100", code: "123456" }) }));
    expect(choice.body.profiles[0].lastInitial).toBeUndefined();
    expect(choice.body.profiles[0].lastName).toBeUndefined();
    expect(Object.keys(choice.body.profiles[0]).sort()).toEqual(["firstName", "id"]);
    const missing = await bodyOf(await app.request("/api/v1/auth/otp/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: ALEX }) }));
    expect(missing.status).toBe(401);
    const stranger = await bodyOf(await app.request("/api/v1/auth/otp/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectionToken: choice.body.selectionToken, customerId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc9" }) }));
    expect(stranger.status).toBe(403);
    const me = await bodyOf(await app.request("/api/v1/me", { headers: auth(ALEX) }));
    expect(me.body.lastName).toBeUndefined();
    expect(me.body.firstName).toBe("Alex");
  });

  it("keeps an SMS opt-out sticky and starts family members opted out", async () => {
    const app = createApp();
    const off = await bodyOf(await app.request("/api/v1/me", { method: "PATCH", headers: auth(ALEX), body: JSON.stringify({ id: "nope", phone: "+19995550000", firstName: "Alejandro", smsOptIn: false, guardianId: "x" }) }));
    expect(off.body.firstName).toBe("Alejandro");
    expect(off.body.phone).toBe("+13195550100");
    expect(off.body.id).toBe(ALEX);
    expect(off.body.smsOptIn).toBe(false);
    const back = await bodyOf(await app.request("/api/v1/me", { method: "PATCH", headers: auth(ALEX), body: JSON.stringify({ smsOptIn: true }) }));
    expect(back.body.smsOptIn).toBe(false);
    const added = await bodyOf(await app.request("/api/v1/me/family", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ firstName: "Sky Reyes", birthYear: 2018 }) }));
    expect(added.status).toBe(201);
    expect(added.body.member.smsOptIn).toBe(false);
    expect(added.body.member.lastName).toBeUndefined();
    expect(added.body.member.firstName).toBe("Sky");
    const fresh = await bodyOf(await app.request("/api/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+13195550999", code: "123456" }) }));
    const created = await bodyOf(await app.request("/api/v1/auth/otp/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectionToken: fresh.body.selectionToken, firstName: "Nuevo" }) }));
    expect(created.body.customer.smsMarketingOptIn).toBe(false);
    expect(created.body.customer.lastName).toBeUndefined();
  });

  it("requires the caller on appointments, receipts, cards, and the kiosk", async () => {
    const app = createApp();
    const routes: { method: string; path: string; body?: unknown }[] = [
      { method: "GET", path: "/api/v1/appointments/NEXT4ALEX01" },
      { method: "POST", path: "/api/v1/appointments/NEXT4ALEX01/cancel" },
      { method: "POST", path: "/api/v1/appointments/NEXT4ALEX01/reschedule", body: { startsAt: "2026-10-26T16:00:00.000Z" } },
      { method: "POST", path: "/api/v1/appointments/NEXT4ALEX01/payment-preview", body: { tipCents: 0 } },
      { method: "POST", path: "/api/v1/appointments/NEXT4ALEX01/payments", body: { tipCents: 0 } },
      { method: "GET", path: "/api/v1/me/receipts/rcpt_past" },
      { method: "DELETE", path: "/api/v1/me/payment-methods/pm_card_visa" },
      { method: "GET", path: "/api/staff/v1/kiosk/qr?shopId=coralville" },
      { method: "DELETE", path: "/api/v1/me/family/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3" },
      { method: "POST", path: "/api/v1/appointments/PAST4ALEX01/rebook" },
    ];
    for (const route of routes) {
      const res = await bodyOf(await app.request(route.path, { method: route.method, headers: { "content-type": "application/json" }, body: route.body ? JSON.stringify(route.body) : undefined }));
      expect(res.status, route.path).toBe(401);
    }
    for (const route of routes.filter((item) => item.path.startsWith("/api/v1"))) {
      const res = await bodyOf(await app.request(route.path, { method: route.method, headers: auth(JORDAN), body: route.body ? JSON.stringify(route.body) : undefined }));
      if (route.path.includes("receipts")) {
        expect(res.status, route.path).toBe(200);
        expect(res.body).toEqual({ receipt: null });
      } else {
        expect(res.status, route.path).toBe(404);
      }
    }
    const visit = await bodyOf(await app.request("/api/v1/appointments/NEXT4ALEX01", { headers: auth(ALEX) }));
    expect(JSON.stringify(visit.body)).not.toContain("notes");
    const unknown = await bodyOf(await app.request("/api/v1/me/receipts/undefined", { headers: auth(ALEX) }));
    expect(unknown.body).toEqual({ receipt: null });
    const list = await bodyOf(await app.request("/api/v1/me/receipts", { headers: auth(ALEX) }));
    expect(list.body.limit).toBe(20);
    expect(list.body.nextCursor).toBeNull();
    expect(list.body.receipts[0].refunds).toBeUndefined();
    const detail = await bodyOf(await app.request("/api/v1/me/receipts/rcpt_past", { headers: auth(ALEX) }));
    expect(detail.body.totalCents).toBe(3603);
    expect(detail.body.serviceCents).toBe(2900);
    expect(detail.body.settlement).toEqual({ shopCents: 3103, tipCents: 500, tipStatus: "with_shop" });
    expect(detail.body.refunds).toEqual([
      expect.objectContaining({ amountCents: 100, from: "shop", shopPortionCents: 100, tipPortionCents: 0 }),
      expect.objectContaining({ from: "shop_and_tip", shopPortionCents: 150, tipPortionCents: 100 }),
    ]);
  });

  it("returns 403 when confirm runs against a closed or unready shop", async () => {
    const world = createWorld();
    world.shops.find((shop) => shop.id === SHOP_CORALVILLE)!.launched = false;
    const closed = createApp(world);
    const preview = await bodyOf(await closed.request("/api/v1/appointments/NEXT4ALEX01/payment-preview", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ tipCents: 0 }) }));
    expect(preview.status).toBe(200);
    expect(preview.body.unavailableCopy).toBe("Book with us at this shop the usual way.");
    const pay = await bodyOf(await closed.request("/api/v1/appointments/NEXT4ALEX01/payments", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ tipCents: 0 }) }));
    expect(pay.status).toBe(403);
    expect(pay.body.error.details.reason).toBe("not_launched");

    const ready = createWorld();
    const shop = ready.shops.find((row) => row.id === SHOP_CORALVILLE)!;
    shop.launched = true;
    shop.chargesEnabled = false;
    const unready = createApp(ready);
    const still = await bodyOf(await unready.request("/api/v1/appointments/NEXT4ALEX01/payment-preview", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ tipCents: 0 }) }));
    expect(still.status).toBe(200);
    expect(still.body.unavailableCopy).toBe("This shop isn't taking cards in the app yet.");
    const failed = await bodyOf(await unready.request("/api/v1/appointments/NEXT4ALEX01/payments", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ tipCents: 0 }) }));
    expect(failed.status).toBe(403);
    expect(failed.body.error.code).toBe("payment_failed");
    expect(failed.body.error.details.reason).toBe("payments_not_ready");
  });

  it("returns Stripe test-card details and sheet secrets, and never a posted PAN", async () => {
    const app = createApp();
    const refused = await bodyOf(await app.request("/api/v1/me/payment-methods/setup", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ number: "4242424242424242", cvc: "123" }) }));
    expect(refused.status).toBe(400);
    const setup = await bodyOf(await app.request("/api/v1/me/payment-methods/setup", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ funding: "credit", brand: "amex", last4: "0000" }) }));
    expect(setup.body.clientSecret).toMatch(/^seti_/);
    expect(setup.body.ephemeralKey).toMatch(/^ek_test_/);
    expect(setup.body.paymentMethod).toMatchObject({ id: "pm_card_visa", brand: "visa", last4: "4242" });
  });

  it("rebooks on the barber grid for the owner only", async () => {
    const app = createApp();
    const booked = await bodyOf(await app.request("/api/v1/appointments/PAST4ALEX01/rebook", { method: "POST", headers: auth(ALEX) }));
    expect(booked.status).toBe(201);
    const plus21 = new Date(Date.parse("2026-09-24T16:30:00.000Z") + 21 * 86400000).toISOString();
    expect(booked.body.appointment.startsAt).not.toBe(plus21);
    expect(booked.body.appointment.startsAt.endsWith(":00:00.000Z")).toBe(true);
    const world = createWorld();
    world.shops.find((shop) => shop.id === SHOP_CORALVILLE)!.launched = false;
    const closed = await bodyOf(await createApp(world).request("/api/v1/appointments/PAST4ALEX01/rebook", { method: "POST", headers: auth(ALEX) }));
    expect(closed.status).toBe(403);
    expect(closed.body.error.details.reason).toBe("not_launched");
  });

  it("deletes with the issued code, keeps the sale, and forfeits loyalty", async () => {
    const world = createWorld();
    const app = createApp(world);
    const start = await bodyOf(await app.request("/api/v1/me/delete/start", { method: "POST", headers: auth(ALEX) }));
    expect(start.body.consequences).toContain("Your loyalty balance will be forfeited.");
    expect(start.body.devCode).not.toBe("123456");
    const wrong = await bodyOf(await app.request("/api/v1/me/delete/confirm", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ code: "123456" }) }));
    expect(wrong.status).toBe(401);
    const confirmed = await bodyOf(await app.request("/api/v1/me/delete/confirm", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ code: start.body.devCode }) }));
    expect(confirmed.body).toEqual({ deleted: true });
    const gone = await app.request("/api/v1/me", { headers: auth(ALEX) });
    expect(gone.status).toBe(401);
    const kept = (world as World & { receipts: { id: string; totalCents: number }[] }).receipts.find((row) => row.id === "rcpt_past");
    expect(kept?.totalCents).toBe(3603);
    const silent = createApp(createWorld(), { devCodes: false });
    const hidden = await bodyOf(await silent.request("/api/v1/me/delete/start", { method: "POST", headers: auth(ALEX) }));
    expect(hidden.body.devCode).toBeUndefined();
  });

  it("derives live wait from chairs and the walk-in list", async () => {
    const app = createApp();
    const coral = await bodyOf(await app.request("/api/v1/shops/coralville/live"));
    const moline = await bodyOf(await app.request("/api/v1/shops/moline/live"));
    expect(coral.body).toEqual({ waitMinutes: 0, chairsFree: 3 });
    expect(moline.body).toEqual({ waitMinutes: 40, chairsFree: 0 });
    expect(coral.body.waitMinutes).not.toBe(10);
    expect(moline.body.waitMinutes).not.toBe(25);
    const home = await bodyOf(await app.request("/api/v1/me/home", { headers: auth(ALEX) }));
    expect(home.body.loyalty.badge).toBeNull();
    expect(home.body.favoriteShop.waitMinutes).toBe(0);
    expect(home.body.nextAppointment.appointment.customer.lastName).toBeUndefined();
  });

  it("gates a closed shop, serves config fields, and filters tickets by the Chicago date", async () => {
    const app = createApp();
    const cfg = await bodyOf(await app.request("/api/v1/app/config"));
    const kimberly = cfg.body.shops.find((shop: { slug: string }) => shop.slug === "kimberly");
    const coral = cfg.body.shops.find((shop: { slug: string }) => shop.slug === "coralville");
    expect(kimberly).toMatchObject({ payments: false, booking: "external", clockIn: false, tipTransfers: false, launched: false });
    expect(coral).toMatchObject({ payments: true, booking: "native", clockIn: false, tipTransfers: true, launched: true });
    expect(cfg.body.minVersion).toEqual({ ios: "3.0.0", android: "1.0.0" });
    expect(cfg.body.weekStartDay).toBeUndefined();
    expect(cfg.body.launched).toBe(true);

    const verified = await bodyOf(await app.request("/api/staff/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+13195550111", code: "123456" }) }));
    const step = await bodyOf(await app.request("/api/staff/v1/auth/step-up", { method: "POST", headers: { authorization: `Bearer ${verified.body.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ pin: "135790" }) }));
    const headers = { authorization: `Bearer ${verified.body.accessToken}`, "x-step-up": step.body.stepUpToken as string };
    expect(step.body.expiresIn).toBe(300);
    const chicago = await bodyOf(await app.request("/api/staff/v1/me/earnings/tickets?from=2026-10-18&to=2026-10-25&date=2026-10-19", { headers }));
    expect(chicago.body.tickets.some((row: { saleId: string }) => row.saleId === "sale_pending")).toBe(true);
    const utc = await bodyOf(await app.request("/api/staff/v1/me/earnings/tickets?from=2026-10-18&to=2026-10-25&date=2026-10-20", { headers }));
    expect(utc.body.tickets.some((row: { saleId: string }) => row.saleId === "sale_pending")).toBe(false);
    const earnings = await app.request("/api/staff/v1/me/earnings?period=current", { headers });
    expect(earnings.headers.get("cache-control")).toBe("private, no-store");
    const clipped = await app.request("/api/staff/v1/me/earnings/report?from=2026-10-16&to=2026-10-20&format=csv", { headers });
    expect(clipped.status).toBe(400);
    const whole = await app.request("/api/staff/v1/me/earnings/report?from=2026-10-11&to=2026-10-17&format=csv", { headers });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("cache-control")).toBe("private, no-store");

    const card = await bodyOf(await app.request(`/api/staff/v1/clients/${ALEX}`, { headers }));
    expect(card.body).toEqual({ firstName: "Alex" });
    const kat = await bodyOf(await app.request("/api/staff/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+13095550222", code: "123456" }) }));
    const hidden = await app.request(`/api/staff/v1/clients/${ALEX}`, { headers: { authorization: `Bearer ${kat.body.accessToken}` } });
    expect(hidden.status).toBe(404);
    expect(kat.body.accessToken).toContain(STAFF_KAT);
    expect(verified.body.accessToken).toContain(STAFF_MAKENNA);

    let clock = Date.parse("2026-10-23T15:00:00.000Z");
    const timed = createApp(createWorld(), { now: () => new Date(clock) });
    const pin = await bodyOf(await timed.request("/api/staff/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+13195550111", code: "123456" }) }));
    const elevated = await bodyOf(await timed.request("/api/staff/v1/auth/step-up", { method: "POST", headers: { authorization: `Bearer ${pin.body.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ pin: "135790" }) }));
    const money = { authorization: `Bearer ${pin.body.accessToken}`, "content-type": "application/json", "x-step-up": elevated.body.stepUpToken as string };
    expect((await timed.request("/api/staff/v1/me/instant-payouts/quote", { method: "POST", headers: { authorization: money.authorization, "content-type": "application/json" }, body: JSON.stringify({ amountCents: 100 }) })).status).toBe(403);
    expect((await timed.request("/api/staff/v1/me/earnings?period=current", { headers: money })).status).toBe(200);
    clock += 5 * 60 * 1000 + 1;
    expect((await timed.request("/api/staff/v1/me/earnings?period=current", { headers: money })).status).toBe(403);
  });

  it("hides the kiosk code from barber tokens and rotates it for a paired device", async () => {
    let clock = Date.parse("2026-10-23T15:00:00.000Z");
    const app = createApp(createWorld(), { now: () => new Date(clock) });
    const barber = await bodyOf(await app.request("/api/staff/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+13195550111", code: "123456" }) }));
    const denied = await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: { authorization: `Bearer ${barber.body.accessToken}` } });
    expect(denied.status).toBe(403);
    const device = { authorization: `Bearer kiosk.${SHOP_CORALVILLE}` };
    const first = await bodyOf(await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: device }));
    expect(first.status).toBe(200);
    clock += 15_000;
    const next = await bodyOf(await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: device }));
    expect(next.body.token).not.toBe(first.body.token);
    expect(next.body.rotatesSeconds).toBe(15);
  });

  it("requires auth on device routes, returns 400 for a bad date, and keeps private responses uncached", async () => {
    const app = createApp();
    expect((await app.request("/api/v1/me/devices/dev1", { method: "DELETE" })).status).toBe(401);
    expect((await app.request("/api/v1/me/devices/dev1", { method: "DELETE", headers: auth(ALEX) })).status).toBe(204);
    expect((await app.request("/api/staff/v1/me/devices", { method: "POST" })).status).toBe(401);
    const verified = await bodyOf(await app.request("/api/staff/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+13195550111", code: "123456" }) }));
    const staff = { authorization: `Bearer ${verified.body.accessToken}`, "content-type": "application/json" };
    expect((await app.request("/api/staff/v1/me/devices", { method: "POST", headers: staff })).status).toBe(201);
    const step = await bodyOf(await app.request("/api/staff/v1/auth/step-up", { method: "POST", headers: staff, body: JSON.stringify({ pin: "135790" }) }));
    const money = { ...staff, "x-step-up": step.body.stepUpToken as string };
    for (const path of ["/api/staff/v1/me/earnings/days?from=nope&to=2026-10-25", "/api/staff/v1/me/earnings/tickets?from=2026-10-32&to=2026-10-25", "/api/staff/v1/me/payouts?from=2026-13-01&to=2026-10-25"]) {
      expect((await app.request(path, { headers: money })).status, path).toBe(400);
    }
    const checks: [string, Record<string, string>][] = [
      ["/api/v1/me", auth(ALEX)],
      ["/api/v1/me/receipts", auth(ALEX)],
      ["/api/v1/me/receipts/rcpt_past", auth(ALEX)],
      ["/api/v1/me/home", auth(ALEX)],
      ["/api/v1/me/payment-methods", auth(ALEX)],
      ["/api/staff/v1/me", staff],
      [`/api/staff/v1/clients/${ALEX}`, staff],
      ["/api/staff/v1/me/payout-account", money],
      ["/api/staff/v1/me/calendar", staff],
    ];
    for (const [path, headers] of checks) {
      const res = await app.request(path, { headers });
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
    }
    expect((await app.request("/api/staff/v1/me/payout-account/session/complete", { method: "POST", headers: staff, body: JSON.stringify({ state: "active" }) })).status).toBe(403);
  });

  it("requires consentTextVersion to opt in and ignores pushReminders", async () => {
    const app = createApp();
    const missing = await bodyOf(await app.request("/api/v1/me", { method: "PATCH", headers: auth(ALEX), body: JSON.stringify({ smsMarketingOptIn: true }) }));
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe("consentTextVersion is required to opt in.");
    const old = await bodyOf(await app.request("/api/v1/me", { method: "PATCH", headers: auth(ALEX), body: JSON.stringify({ pushReminders: false }) }));
    expect(old.body.pushReminders).toBeUndefined();
    expect(old.body.pushTransactional).toBe(true);
    const on = await bodyOf(await app.request("/api/v1/me", { method: "PATCH", headers: auth(ALEX), body: JSON.stringify({ smsMarketingOptIn: true, pushTransactional: true, consentTextVersion: "2026-10-23" }) }));
    expect(on.status).toBe(200);
    expect(on.body.smsMarketingOptIn).toBe(true);
    expect(on.body.pushTransactional).toBe(true);
  });

  it("leaves Sundays and other closed days off the book and answers 426 below the Android minimum", async () => {
    const app = createApp();
    const days = await bodyOf(await app.request("/api/v1/shops/coralville/available-days?from=2026-10-23"));
    expect(days.body.days.map((day: { date: string }) => day.date)).not.toContain("2026-10-25");
    expect(days.body.days.map((day: { date: string }) => day.date)).not.toContain("2026-10-24");
    expect(days.body.days[0].date).toBe("2026-10-23");
    const sunday = await bodyOf(await app.request("/api/v1/shops/coralville/availability?date=2026-10-25"));
    expect(sunday.body.slots).toEqual([]);
    expect(sunday.body.reason).toBe("closed");
    const booked = await bodyOf(await app.request("/api/v1/appointments", { method: "POST", headers: auth(ALEX), body: JSON.stringify({ shopId: "coralville", serviceId: "svc-cut", startsAt: "2026-10-25T16:00:00.000Z" }) }));
    expect(booked.status).toBe(409);
    const stale = await app.request("/api/v1/app/config", { headers: { "x-client": "android", "x-app-version": "0.9.0" } });
    expect(stale.status).toBe(426);
    const current = await app.request("/api/v1/app/config", { headers: { "x-client": "android", "x-app-version": "1.0.0" } });
    expect(current.status).toBe(200);
  });
});
