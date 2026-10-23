/**
 * Mobile API findings: opt-out sticks across a later booking and a Squire re-import,
 * dry-run imports commit in batches, appointment codes expire at the cutoff,
 * per-IP limits, devices, purchases, customer notes, and Connect onboarding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { Mods, actor, loadModules } from "./setup";

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 180_000);

afterAll(async () => {
  delete process.env.IMPORT_BATCH_ROWS;
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

async function openSlot(offset = 4) {
  const svc = (await m.public.publicServices("coralville")).services[0];
  for (let i = offset; i < 24; i++) {
    const date = m.time.addDays(m.time.todayLocal(), i);
    const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: "any" });
    if (a.slots.length) return { svc, slot: a.slots[a.slots.length - 1] };
  }
  throw new Error("no slots");
}

async function twoSlots() {
  const svc = (await m.public.publicServices("coralville")).services[0];
  for (let i = 3; i < 24; i++) {
    const date = m.time.addDays(m.time.todayLocal(), i);
    const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: "any" });
    if (a.slots.length >= 2) return { svc, first: a.slots[0], second: a.slots[a.slots.length - 1] };
  }
  throw new Error("no slots");
}

describe("consent sticks once opted out", () => {
  it("a second booking cannot turn texts back on", async () => {
    const phone = "+13195550181";
    const { svc, first, second } = await twoSlots();
    await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: "any",
      startsAt: first.startsAt,
      customer: { firstName: "Ada", lastName: "Optout", phone, smsOptIn: true },
      source: "online",
      actor,
    });
    const optedOut = await m.customers.findOrCreateCustomer({ firstName: "Ada", lastName: "Optout", phone, smsOptIn: false }, null);
    expect(optedOut.smsOptIn).toBe(false);
    await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: "any",
      startsAt: second.startsAt,
      customer: { firstName: "Ada", lastName: "Optout", phone, smsOptIn: true },
      source: "online",
      actor,
    });
    const row = await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.phone, phone) });
    expect(row?.smsOptIn).toBe(false);
    const { recordConsent } = await import("@/server/mobile/consent");
    await recordConsent({ customerId: row!.id, phone, channel: "sms_transactional", action: "granted", source: "ios", textVersion: "2026-10-22" });
    const again = await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, row!.id) });
    expect(again?.smsOptIn).toBe(true);
  });

  it("a Squire re-import cannot turn an opt-out back on, and a non-id match updates changed fields", async () => {
    const header = "Client ID,First Name,Last Name,Phone,Email,Location,SMS Opt In";
    const created = await m.importer.runImport(
      "clients",
      `${header}\nSQ-M100,Ann,Lee,(319) 555-0171,ann@lee.test,Coralville,Yes\nSQ-M101,Ann,Lee,(319) 555-0172,ann@lee.test,Coralville,\n`,
      { dryRun: false, actor },
    );
    expect(created.inserted).toBe(1);
    expect(created.updated).toBe(1);
    const ann = await m.customers.customerBySquireId(m.db.db, "SQ-M100");
    expect(ann).toMatchObject({ phone: "+13195550172", email: "ann@lee.test", smsOptIn: true, firstName: "Ann" });
    expect(await m.customers.customerBySquireId(m.db.db, "SQ-M101")).toMatchObject({ id: ann!.id });

    await m.importer.runImport("clients", `${header}\nSQ-M100,Ann,Lee,(319) 555-0172,ann@lee.test,Coralville,No\n`, { dryRun: false, actor });
    expect((await m.customers.customerBySquireId(m.db.db, "SQ-M100"))!.smsOptIn).toBe(false);
    await m.importer.runImport("clients", `${header}\nSQ-M100,Ann,Lee,(319) 555-0172,ann@lee.test,Coralville,Yes\n`, { dryRun: false, actor });
    expect((await m.customers.customerBySquireId(m.db.db, "SQ-M100"))!.smsOptIn).toBe(false);
  });

  it("a dry-run of more than one batch rolls back and still matches in-file duplicates", async () => {
    process.env.IMPORT_BATCH_ROWS = "2";
    try {
      const header = "Client ID,First Name,Last Name,Phone,Email,Location,SMS Opt In";
      const csv = [
        header,
        "SQ-M200,Nell,Batch,(319) 555-0181,nell@batch.test,Coralville,Yes",
        "SQ-M201,Otto,Batch,(319) 555-0182,otto@batch.test,Coralville,No",
        "SQ-M202,Nell,Batch,(319) 555-0199,nell@batch.test,Coralville,Yes",
      ].join("\n");
      const dry = await m.importer.runImport("clients", csv, { dryRun: true, actor });
      expect(dry.inserted).toBe(2);
      expect(dry.updated).toBe(1);
      expect(await m.customers.customerBySquireId(m.db.db, "SQ-M200")).toBeNull();
      expect(await m.customers.customerBySquireId(m.db.db, "SQ-M202")).toBeNull();
    } finally {
      delete process.env.IMPORT_BATCH_ROWS;
    }
  });
});

describe("appointment codes and rate limits", () => {
  it("the code works until the cutoff, then only the customer's token does", async () => {
    const { svc, slot } = await openSlot(6);
    const phone = "+13195550183";
    const booked = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: "any",
      startsAt: slot.startsAt,
      customer: { firstName: "Code", phone },
      source: "online",
      actor,
    });
    const route = await import("@/app/api/v1/appointments/[code]/route");
    const get = (headers?: Record<string, string>) =>
      route.GET(new Request(`http://localhost/api/v1/appointments/${booked.code}`, { headers }), { params: Promise.resolve({ code: booked.code }) });
    expect((await get()).status).toBe(200);
    const owner = await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.phone, phone) });
    const other = await m.customers.findOrCreateCustomer({ firstName: "Other", phone: "+13195550184" }, null);
    const otherToken = (await m.auth.issueTokens(other.id, null)).accessToken;
    expect((await get({ authorization: `Bearer ${otherToken}` })).status).toBe(404);
    const past = new Date("2020-06-15T15:00:00Z");
    await m.db.db.update(m.schema.appointments).set({ startsAt: past, endsAt: new Date(past.getTime() + 30 * 60_000) }).where(eq(m.schema.appointments.id, booked.id));
    expect((await get()).status).toBe(401);
    const token = (await m.auth.issueTokens(owner!.id, null)).accessToken;
    expect((await get({ authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it("otp/start is capped per IP", async () => {
    process.env.AUTH_DEV_CODES = "true";
    const route = await import("@/app/api/v1/auth/otp/start/route");
    let limited = 0;
    for (let i = 0; i < 22; i++) {
      const res = await route.POST(
        new Request("http://localhost/api/v1/auth/otp/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
          body: JSON.stringify({ phone: `31955502${String(i).padStart(2, "0")}` }),
        }),
        { params: Promise.resolve({}) },
      );
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("customer app endpoints", () => {
  it("registers a push device, returns purchases and the customer's own note, and lists shops with a next slot", async () => {
    const customer = await m.customers.findOrCreateCustomer({ firstName: "Nia", phone: "+13195550185" }, null);
    await m.db.db.update(m.schema.customers).set({ notes: "STAFF-ONLY-NOTE" }).where(eq(m.schema.customers.id, customer.id));
    const token = (await m.auth.issueTokens(customer.id, null)).accessToken;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const devices = await import("@/app/api/v1/me/devices/route");
    const registered = await devices.POST(
      new Request("http://localhost/api/v1/me/devices", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ platform: "ios", provider: "apns", token: "device-token-nia-001" }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(registered.status).toBe(201);
    const listed = await devices.GET(new Request("http://localhost/api/v1/me/devices", { headers: auth }), { params: Promise.resolve({}) });
    expect(await listed.json()).toMatchObject({ devices: [{ platform: "ios", provider: "apns" }] });

    const shop = await m.catalog.getShop("coralville");
    const [sale] = await m.db.db
      .insert(m.schema.sales)
      .values({ shopId: shop.id, customerId: customer.id, status: "paid", businessDate: m.time.todayLocal(), productNetCents: 1200, productGrossCents: 1200, totalCents: 1200, paidAt: new Date() })
      .returning();
    await m.db.db.insert(m.schema.saleItems).values({ saleId: sale.id, kind: "product", name: "Clay", qty: 1, unitPriceCents: 1200, grossCents: 1200, netCents: 1200 });
    const purchases = await import("@/app/api/v1/me/purchases/route");
    const history = await purchases.GET(new Request("http://localhost/api/v1/me/purchases", { headers: auth }), { params: Promise.resolve({}) });
    const body = await history.json();
    expect(body.lastProduct.name).toBe("Clay");
    expect(body.purchases[0]).toMatchObject({ productCents: 1200, serviceCents: 0, taxCents: 0, tipCents: 0, paidAt: expect.any(String) });
    expect(body.purchases[0].paidAt).toMatch(/Z$/);
    expect(JSON.stringify(body)).not.toMatch(/STAFF-ONLY-NOTE/);

    const refundAt = new Date("2026-06-20T18:30:00Z");
    await m.db.db.insert(m.schema.refunds).values({
      saleId: sale.id,
      shopId: shop.id,
      businessDate: m.time.todayLocal(),
      method: "card",
      amountCents: 400,
      productNetCents: 400,
      taxCents: 0,
      tipCents: 0,
      reason: "Changed mind",
      createdAt: refundAt,
    });
    const again = await purchases.GET(new Request("http://localhost/api/v1/me/purchases", { headers: auth }), { params: Promise.resolve({}) });
    const afterRefund = await again.json();
    expect(afterRefund.purchases[0].productCents).toBe(1200);
    expect(afterRefund.purchases[0].refunds).toEqual([
      expect.objectContaining({ amountCents: 400, productCents: 400, serviceCents: 0, taxCents: 0, tipCents: 0, createdAt: refundAt.toISOString() }),
    ]);
    const receiptRoute = await import("@/app/api/v1/me/purchases/receipt/route");
    const receiptRes = await receiptRoute.GET(new Request(`http://localhost/api/v1/me/purchases/receipt?id=${sale.id}`, { headers: auth }), { params: Promise.resolve({}) });
    const receipt = await receiptRes.json();
    expect(receipt.receipt.text).toMatch(/Products \$12\.00/);
    expect(receipt.receipt.text).toMatch(/Refund /);
    expect(receipt.receipt.text).not.toMatch(/\b(?:[01]\d|2[0-3]):[0-5]\d\b(?!\s*[AP]M)/);
    expect(receipt.receipt.productCents).toBe(1200);

    const config = await import("@/app/api/v1/app/config/route");
    const cfg = await (await config.GET(new Request("http://localhost/api/v1/app/config"), { params: Promise.resolve({}) })).json();
    expect(cfg.timeFormat).toBe("12h");
    expect(cfg.timezone).toBe("America/Chicago");
    expect(cfg.launched).toBe(true);
    expect(cfg.launchAt).toBe("2000-01-01T00:00:00.000Z");
    expect(cfg.minIos).toEqual(expect.any(String));
    expect(cfg.minVersion).toEqual({ ios: cfg.minIos, android: cfg.minAndroid });
    expect(cfg.forceUpdateBelow).toEqual(cfg.minVersion);
    expect(cfg.flags).toMatchObject({ appReviewLogin: false, walletCardFee: false });

    const me = await import("@/app/api/v1/me/route");
    const patched = await me.PATCH(
      new Request("http://localhost/api/v1/me", { method: "PATCH", headers: auth, body: JSON.stringify({ notes: "Skin fade" }) }),
      { params: Promise.resolve({}) },
    );
    const profile = await patched.json();
    expect(profile.notes).toBe("Skin fade");
    expect(JSON.stringify(profile)).not.toMatch(/STAFF-ONLY-NOTE/);
    const rejected = await me.PATCH(
      new Request("http://localhost/api/v1/me", { method: "PATCH", headers: auth, body: JSON.stringify({ email: "new@example.com" }) }),
      { params: Promise.resolve({}) },
    );
    expect(rejected.status).toBe(400);

    const shops = await import("@/app/api/v1/shops/route");
    const list = await shops.GET(new Request("http://localhost/api/v1/shops"), { params: Promise.resolve({}) });
    const payload = await list.json();
    const coralville = payload.shops.find((s: { slug: string }) => s.slug === "coralville");
    expect(coralville).toMatchObject({ openNow: expect.any(Boolean), lat: null, lng: null });
    expect(coralville.nextSlot === null || typeof coralville.nextSlot.startsAt === "string").toBe(true);
  }, 60_000);

  it("does not text or email an imported appointment unless notifyClients is set, and keeps imported sales marked", async () => {
    const now = new Date("2026-10-23T15:00:00Z");
    const clients = "Client ID,First Name,Last Name,Phone,Email,Location,SMS Opt In,Email Marketing";
    await m.importer.runImport(
      "clients",
      `${clients}\nSQ-N1,Nora,Optin,(319) 555-0191,nora@optin.test,Coralville,Yes,No\nSQ-N2,Ned,Optout,(319) 555-0192,ned@optout.test,Coralville,No,No\n`,
      { dryRun: false, actor, now },
    );
    const header = "Appointment ID,Date,Time,Location,Barber,Client ID,Client Name,Phone,Email,Services,Price,Duration,Status";
    const row = (id: string, time: string, client: string, name: string, phone: string, email: string) =>
      `${id},8/17/2027,${time},Coralville,Makenna,${client},${name},${phone},${email},Haircut,35,30,booked`;
    const quiet = await m.importer.runImport("appointments", `${header}\n${row("AP-N1", "10:00 AM", "SQ-N1", "Nora Optin", "(319) 555-0191", "nora@optin.test")}\n`, {
      dryRun: false,
      actor,
      now,
    });
    expect(quiet.inserted).toBe(1);
    const jobsFor = async (squireId: string) =>
      (await m.db.db.execute(m.drizzle.sql`
        select j.kind, j.channel from notification_jobs j
        join appointments a on a.id = j.appointment_id
        where a.squire_id = ${squireId}`)) as unknown as { kind: string; channel: string }[];
    expect(await jobsFor("AP-N1")).toEqual([]);

    const loud = await m.importer.runImport(
      "appointments",
      `${header}\n${row("AP-N2", "11:00 AM", "SQ-N1", "Nora Optin", "(319) 555-0191", "nora@optin.test")}\n${row("AP-N3", "12:00 PM", "SQ-N2", "Ned Optout", "(319) 555-0192", "ned@optout.test")}\n`,
      { dryRun: false, actor, now, notifyClients: true },
    );
    expect(loud.inserted).toBe(2);
    const optedIn = await jobsFor("AP-N2");
    expect(optedIn.map((j) => j.kind).sort()).toEqual(["reminder_24h", "reminder_2h"]);
    expect(optedIn.every((j) => j.channel === "sms")).toBe(true);
    expect(await jobsFor("AP-N3")).toEqual([]);

    await m.importer.runImport(
      "transactions",
      "Transaction ID,Date,Time,Location,Barber,Client ID,Services,Tip,Tax,Discount,Total,Payment Method,Status\nTX-N1,8/1/2026,10:00 AM,Coralville,Makenna,SQ-N1,35,5,0,0,40,Card,paid\n",
      { dryRun: false, actor, now },
    );
    const [sale] = await m.db.db.select().from(m.schema.sales).where(eq(m.schema.sales.squireRef, "TX-N1"));
    expect(sale.isImported).toBe(true);
    const [pay] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, sale.id));
    expect(pay.processor).toBe("squire_import");
  });

  it("keeps tip-to-barber off and settles the whole ticket, tip included, to the shop", async () => {
    const { createBarberConnectOnboardingLink } = await import("@/server/payments/barber-connect");
    const { TIP_TO_BARBER_LABEL, executeChargePlan, reverseChargePlan, tipToBarberEnabled } = await import("@/server/payments/charge-plan");
    expect(tipToBarberEnabled()).toBe(false);
    const shop = await m.catalog.getShop("coralville");
    const plan = await executeChargePlan({
      shopId: shop.id,
      paymentMethodId: "pm_card_visa",
      amountCents: 2500,
      tipCents: 500,
      description: "Test shop settlement",
      idempotencyKey: `mobile-${crypto.randomUUID()}`,
    });
    expect(plan.kind).toBe("destination");
    expect(plan.processor).toBe("simulator");
    expect(plan.tipToBarber).toBe(false);
    expect(plan.destinationAccount).toMatch(/^sim_acct_/);
    const tip = plan.transfers.find((r) => r.role === "tip");
    const shopNet = plan.transfers.find((r) => r.role === "shop_net");
    expect(tip).toMatchObject({ status: "skipped", amountCents: 500 });
    expect(tip?.note).toContain(TIP_TO_BARBER_LABEL);
    expect(tip?.note).toMatch(/iSolved/);
    expect(shopNet?.status).toBe("executed");
    expect(shopNet?.note).toMatch(/Includes the tip/);
    expect(shopNet!.amountCents).toBeGreaterThan(2000);
    expect(shopNet!.amountCents).toBeLessThan(2500);

    const [makenna] = await m.db.db.select().from(m.schema.staff).where(eq(m.schema.staff.firstName, "Makenna"));
    const barber = await createBarberConnectOnboardingLink(makenna.id);
    expect(barber.stripeAccountId).toMatch(/^acct_sim_staff_/);
    process.env.FEATURE_TIP_TO_BARBER = "true";
    try {
      const split = await executeChargePlan({
        shopId: shop.id,
        staffId: makenna.id,
        paymentMethodId: "pm_card_visa",
        amountCents: 2500,
        tipCents: 500,
        description: "Tip split while the flag is on",
        idempotencyKey: `mobile-tip-${crypto.randomUUID()}`,
        kind: "separate_charges_transfers",
      });
      expect(split.tipToBarber).toBe(true);
      expect(split.destinationAccount).toBeNull();
      expect(split.transfers.find((r) => r.role === "tip")).toMatchObject({ status: "executed", amountCents: 500, destinationAccount: barber.stripeAccountId });
      expect(split.transfers.find((r) => r.role === "shop_net")).toMatchObject({ status: "executed", amountCents: 2000 });
      const claw = await reverseChargePlan({ paymentIntentId: split.paymentIntentId, refundCents: 500, idempotencyKey: `rev-${split.paymentIntentId}` });
      expect(claw.reversals).toEqual([expect.objectContaining({ role: "tip", amountCents: 500 })]);
    } finally {
      delete process.env.FEATURE_TIP_TO_BARBER;
    }

    const back = await reverseChargePlan({ paymentIntentId: plan.paymentIntentId, refundCents: shopNet!.amountCents, idempotencyKey: `rev-${plan.paymentIntentId}` });
    expect(back.reversals).toEqual([expect.objectContaining({ role: "shop_net", amountCents: shopNet!.amountCents })]);
    const [skippedTip] = await m.db.db.select().from(m.schema.connectTransfers).where(eq(m.schema.connectTransfers.id, tip!.id));
    expect(skippedTip.status).toBe("skipped");

    const { computeCardFee } = await import("@/server/payments/card-fee");
    const credit = await computeCardFee(shop.id, "credit", { chargeCents: 10_000, tipCents: 0 });
    const debit = await computeCardFee(shop.id, "debit", { chargeCents: 10_000, tipCents: 0 });
    expect(credit.feeCents).toBeGreaterThan(0);
    expect(credit.reason).toBe("applies");
    expect(debit.feeCents).toBe(0);
    expect(debit.reason).toBe("not_credit");
  });
});

describe("launch gate", () => {
  const future = "2999-01-01T15:00:00.000Z";
  const past = "2000-01-01T00:00:00.000Z";

  afterAll(() => {
    process.env.LAUNCH_AT = past;
  });

  it("keeps customer booking, payments, and push closed until LAUNCH_AT, and leaves staff booking open", async () => {
    const { COMING_SOON_MESSAGE } = await import("@/server/launch");
    const { svc, first, second } = await twoSlots();
    const booked = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: "any",
      startsAt: first.startsAt,
      customer: { firstName: "Launch", phone: "+13195550190" },
      source: "online",
      actor,
    });

    process.env.LAUNCH_AT = future;
    const config = await import("@/app/api/v1/app/config/route");
    const closed = await (await config.GET(new Request("http://localhost/api/v1/app/config"), { params: Promise.resolve({}) })).json();
    expect(closed.launched).toBe(false);
    expect(closed.launchAt).toBe(future);
    expect(closed.pilot).toBe(false);
    expect(closed.pilotShops).toEqual([]);
    expect(closed.timeFormat).toBe("12h");
    expect(closed.minVersion).toEqual({ ios: closed.minIos, android: closed.minAndroid });
    expect(closed.forceUpdateBelow).toEqual(closed.minVersion);

    const tooOld = await config.GET(
      new Request("http://localhost/api/v1/app/config", { headers: { "x-client": "ios", "x-app-version": "0.0.1" } }),
      { params: Promise.resolve({}) },
    );
    expect(tooOld.status).toBe(426);
    const upgrade = await tooOld.json();
    expect(upgrade.error.code).toBe("upgrade_required");
    expect(upgrade.error.details.forceUpdate).toBe(true);
    expect(upgrade.error.details.minSupportedVersion).toBe(closed.minIos);

    await expect(
      m.booking.createAppointment({
        shopRef: "coralville",
        serviceId: svc.id,
        barberRef: "any",
        startsAt: second.startsAt,
        customer: { firstName: "Early", phone: "+13195550191" },
        source: "api",
        actor,
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: COMING_SOON_MESSAGE, details: { reason: "not_launched", surface: "booking", launchAt: future } });

    const staffBooked = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: "any",
      startsAt: second.startsAt,
      customer: { firstName: "Desk", phone: "+13195550192" },
      source: "staff",
      actor,
    });
    expect(staffBooked.code).toEqual(expect.any(String));

    await expect(
      m.booking.rescheduleAppointment(booked.code, { startsAt: second.startsAt, actor, byCustomer: true }),
    ).rejects.toMatchObject({ details: { reason: "not_launched", surface: "booking" } });

    const { executeChargePlan } = await import("@/server/payments/charge-plan");
    const shop = await m.catalog.getShop("coralville");
    await expect(
      executeChargePlan({
        shopId: shop.id,
        paymentMethodId: "pm_card_visa",
        amountCents: 1500,
        description: "Customer checkout before launch",
        idempotencyKey: `prelaunch-${crypto.randomUUID()}`,
        customerFacing: true,
      }),
    ).rejects.toMatchObject({ details: { reason: "not_launched", surface: "payments" } });
    const pos = await executeChargePlan({
      shopId: shop.id,
      paymentMethodId: "pm_card_visa",
      amountCents: 1500,
      description: "Staff checkout before launch",
      idempotencyKey: `pos-${crypto.randomUUID()}`,
    });
    expect(pos.processor).toBe("simulator");

    const prevApns = {
      APNS_KEY_ID: process.env.APNS_KEY_ID,
      APNS_TEAM_ID: process.env.APNS_TEAM_ID,
      APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
      APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID,
    };
    process.env.APNS_KEY_ID = "KEY";
    process.env.APNS_TEAM_ID = "TEAM";
    process.env.APNS_PRIVATE_KEY = "not-a-real-key";
    process.env.APNS_BUNDLE_ID = "com.rayz.customer";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { sendPush } = await import("@/server/mobile/push");
      await expect(sendPush("apns", "device-token", { type: "reminder", title: "Ray'z", body: "See you soon" })).resolves.toEqual({
        sent: false,
        unregistered: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      for (const [key, value] of Object.entries(prevApns)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    delete process.env.LAUNCH_AT;
    const later = new Date("2999-06-01T15:00:00.000Z");
    const brand = await m.db.db.query.brandSettings.findFirst();
    expect(brand?.id).toBeDefined();
    await m.db.db.update(m.schema.brandSettings).set({ launchAt: later }).where(eq(m.schema.brandSettings.id, brand!.id));
    const { launchState } = await import("@/server/launch");
    expect(await launchState()).toMatchObject({ launched: false, launchAt: later.toISOString() });
    process.env.LAUNCH_AT = past;
    expect(await launchState()).toMatchObject({ launched: true, launchAt: past });
    await m.db.db.update(m.schema.brandSettings).set({ launchAt: null }).where(eq(m.schema.brandSettings.id, brand!.id));
  });

  it("lets one shop pilot before the brand instant, and hold a shop back after it", async () => {
    const { COMING_SOON_MESSAGE, effectiveLaunch } = await import("@/server/launch");
    expect(effectiveLaunch(new Date("2020-01-01T00:00:00.000Z"), { launched: false, launchAt: future, scope: "brand" }, new Date("2026-01-01T00:00:00.000Z")).launched).toBe(true);
    expect(effectiveLaunch(null, { launched: false, launchAt: future, scope: "brand" }).launched).toBe(false);

    process.env.LAUNCH_AT = future;
    const coralville = await m.catalog.getShop("coralville");
    const moline = await m.catalog.getShop("moline");
    const pilotAt = new Date("2020-01-01T00:00:00.000Z");
    await m.db.db.update(m.schema.shops).set({ launchAt: pilotAt }).where(eq(m.schema.shops.id, coralville.id));
    try {
      const { svc, slot } = await openSlot(8);
      const booked = await m.booking.createAppointment({
        shopRef: "coralville",
        serviceId: svc.id,
        barberRef: "any",
        startsAt: slot.startsAt,
        customer: { firstName: "Pilot", phone: "+13195550193" },
        source: "online",
        actor,
      });
      expect(booked.code).toEqual(expect.any(String));

      const molineSvc = (await m.public.publicServices("moline")).services[0];
      if (!molineSvc) throw new Error("moline has no services");
      let molineSlot: string | undefined;
      for (let i = 4; i < 20 && !molineSlot; i++) {
        const day = await m.booking.getAvailability({ shopRef: "moline", date: m.time.addDays(m.time.todayLocal(), i), serviceId: molineSvc.id, barberRef: "any" });
        molineSlot = day.slots.at(-1)?.startsAt;
      }
      await expect(
        m.booking.createAppointment({
          shopRef: "moline",
          serviceId: molineSvc.id,
          barberRef: "any",
          startsAt: molineSlot!,
          customer: { firstName: "Wait", phone: "+13195550194" },
          source: "api",
          actor,
        }),
      ).rejects.toMatchObject({ message: COMING_SOON_MESSAGE, details: { reason: "not_launched", scope: "brand", shopId: moline.id } });

      const config = await import("@/app/api/v1/app/config/route");
      const cfg = await (await config.GET(new Request("http://localhost/api/v1/app/config"), { params: Promise.resolve({}) })).json();
      expect(cfg.launched).toBe(true);
      expect(cfg.pilot).toBe(true);
      expect(cfg.pilotShops).toEqual(["coralville"]);
      expect(cfg.launchAt).toBe(future);

      const shops = await import("@/app/api/v1/shops/route");
      const list = await (await shops.GET(new Request("http://localhost/api/v1/shops"), { params: Promise.resolve({}) })).json();
      expect(list.shops.find((s: { slug: string }) => s.slug === "coralville")).toMatchObject({ launched: true, launchAt: pilotAt.toISOString() });
      expect(list.shops.find((s: { slug: string }) => s.slug === "moline")).toMatchObject({ launched: false, launchAt: future });

      const { executeChargePlan } = await import("@/server/payments/charge-plan");
      const paid = await executeChargePlan({
        shopId: coralville.id,
        paymentMethodId: "pm_card_visa",
        amountCents: 1200,
        description: "Pilot shop checkout",
        idempotencyKey: `pilot-${crypto.randomUUID()}`,
        customerFacing: true,
      });
      expect(paid.processor).toBe("simulator");
      await expect(
        executeChargePlan({
          shopId: moline.id,
          paymentMethodId: "pm_card_visa",
          amountCents: 1200,
          description: "Held shop checkout",
          idempotencyKey: `held-${crypto.randomUUID()}`,
          customerFacing: true,
        }),
      ).rejects.toMatchObject({ details: { reason: "not_launched", shopId: moline.id } });

      process.env.LAUNCH_AT = past;
      await m.db.db.update(m.schema.shops).set({ launchAt: new Date(future) }).where(eq(m.schema.shops.id, coralville.id));
      await expect(
        m.booking.createAppointment({
          shopRef: "coralville",
          serviceId: svc.id,
          barberRef: "any",
          startsAt: slot.startsAt,
          customer: { firstName: "Held", phone: "+13195550195" },
          source: "online",
          actor,
        }),
      ).rejects.toMatchObject({ details: { reason: "not_launched", scope: "shop" } });
    } finally {
      process.env.LAUNCH_AT = past;
      await m.db.db.update(m.schema.shops).set({ launchAt: null }).where(eq(m.schema.shops.id, coralville.id));
    }
  });
});
