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
    expect(JSON.stringify(body)).not.toMatch(/STAFF-ONLY-NOTE/);

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

  it("keeps tip-to-barber off and uses separate charges instead of a destination hard-wire", async () => {
    const { createBarberConnectOnboardingLink, createConnectOnboardingLink } = await import("@/server/payments/connect");
    const { TIP_TO_BARBER_LABEL, executeChargePlan, reverseChargePlan, tipToBarberEnabled } = await import("@/server/payments/charge-plan");
    expect(tipToBarberEnabled()).toBe(false);
    const link = await createConnectOnboardingLink("coralville");
    expect(link.mode).toBe("simulator");
    expect(link.stripeAccountId).toMatch(/^acct_sim_/);
    expect(link.ownerEntityId).toBeNull();
    const shop = await m.catalog.getShop("coralville");
    const plan = await executeChargePlan({
      shopId: shop.id,
      paymentMethodId: "pm_card_visa",
      amountCents: 2500,
      tipCents: 500,
      description: "Test separate charges",
      idempotencyKey: `mobile-${crypto.randomUUID()}`,
    });
    expect(plan.kind).toBe("separate_charges_transfers");
    expect(plan.processor).toBe("simulator");
    expect(plan.tipToBarber).toBe(false);
    expect(plan.onBehalfOf).toBe(link.stripeAccountId);
    expect(plan.destinationAccount).toBeNull();
    const tip = plan.transfers.find((r) => r.role === "tip");
    const shopNet = plan.transfers.find((r) => r.role === "shop_net");
    expect(tip).toMatchObject({ status: "skipped", amountCents: 500 });
    expect(tip?.note).toContain(TIP_TO_BARBER_LABEL);
    expect(tip?.note).toMatch(/iSolved/);
    expect(shopNet).toMatchObject({ status: "executed", amountCents: 2500, destinationAccount: link.stripeAccountId });
    expect(shopNet?.stripeTransferId).toMatch(/^sim_tr_/);

    const dest = await executeChargePlan({
      shopId: shop.id,
      paymentMethodId: "pm_card_visa",
      amountCents: 2000,
      tipCents: 400,
      description: "Explicit destination plan",
      idempotencyKey: `mobile-dest-${crypto.randomUUID()}`,
      kind: "destination",
    });
    expect(dest.destinationAccount).toBe(link.stripeAccountId);
    expect(dest.tipToBarber).toBe(false);
    expect(dest.transfers.find((r) => r.role === "tip")?.status).toBe("skipped");

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
      });
      expect(split.tipToBarber).toBe(true);
      expect(split.transfers.find((r) => r.role === "tip")).toMatchObject({ status: "executed", amountCents: 500, destinationAccount: barber.stripeAccountId });
      expect(split.transfers.find((r) => r.role === "shop_net")).toMatchObject({ status: "executed", amountCents: 2000 });
      const claw = await reverseChargePlan({ paymentIntentId: split.paymentIntentId, refundCents: 500, idempotencyKey: `rev-${split.paymentIntentId}` });
      expect(claw.reversals).toEqual([expect.objectContaining({ role: "tip", amountCents: 500 })]);
    } finally {
      delete process.env.FEATURE_TIP_TO_BARBER;
    }

    const back = await reverseChargePlan({ paymentIntentId: plan.paymentIntentId, refundCents: 2500, idempotencyKey: `rev-${plan.paymentIntentId}` });
    expect(back.reversals).toEqual([expect.objectContaining({ role: "shop_net", amountCents: 2500 })]);
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
