/**
 * Runs the PR #7 mock-api customer fixture (Coralville $29 cut, 7% tax, $5 tip, 3% credit fee)
 * against the real /api/v1 handlers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;

beforeAll(async () => {
  process.env.AUTH_DEV_CODES = "true";
  m = await loadModules();
}, 180_000);

afterAll(async () => {
  delete process.env.AUTH_DEV_CODES;
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

function call(mod: { POST?: Function; GET?: Function; DELETE?: Function; PATCH?: Function }, method: "POST" | "GET" | "DELETE" | "PATCH", url: string, params: Record<string, string>, init: RequestInit = {}) {
  const handler = mod[method] as (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  return handler(new Request(url, init), { params: Promise.resolve(params) });
}

async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

describe("customer contract against mock fixtures", () => {
  it("serves config, home, family, live wait, cards, pay, receipts, rebook, and deletion", async () => {
    const configMod = await import("@/app/api/v1/app/config/route");
    const cfg = await json(await call(configMod, "GET", "http://localhost/api/v1/app/config", {}));
    expect(cfg.body.timezone).toBe("America/Chicago");
    expect(cfg.body.timeZone).toBe("America/Chicago");
    expect(cfg.body.weekStartDay).toBe("sunday");
    expect(cfg.body.timeFormat).toBe("12h");
    expect(cfg.body.minSupportedVersion).toEqual(cfg.body.minVersion);
    expect(cfg.body.latestVersion).toEqual({ ios: cfg.body.latestIos, android: cfg.body.latestAndroid });
    expect(cfg.body.featureFlags).toMatchObject({ payments: true, family: true });
    expect(cfg.body.launched).toBe(true);
    const coral = cfg.body.shops.find((s: { slug: string }) => s.slug === "coralville");
    expect(coral).toMatchObject({ launched: true, booking: "native", payments: true, clockIn: false, tipTransfers: true, closedCopy: null });
    expect(coral.shopId).toBe(coral.id);

    const services = await m.public.publicServices("coralville");
    const cut = services.services.find((s) => s.slug === "rayz-cut")!;
    expect(cut.priceCents).toBe(2900);
    let slot: { startsAt: string; barberIds: string[] } | undefined;
    for (let i = 4; i < 21 && !slot; i++) {
      const day = await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(m.time.todayLocal(), i), serviceId: cut.id, barberRef: "any" });
      slot = day.slots.at(-1);
    }
    if (!slot) throw new Error("no slots");
    const booked = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: cut.id,
      barberRef: slot.barberIds[0],
      startsAt: slot.startsAt,
      customer: { firstName: "Alex", lastName: "Reyes", phone: "3195550191" },
      source: "api",
      actor,
    });
    const customerId = booked.customer!.id;
    const token = (await m.auth.issueTokens(customerId, null)).accessToken;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const homeMod = await import("@/app/api/v1/me/home/route");
    const home = await json(await call(homeMod, "GET", "http://localhost/api/v1/me/home", {}, { headers: auth }));
    expect(home.status).toBe(200);
    expect(home.body.nextAppointment.appointment.code).toBe(booked.code);
    expect(home.body.nextAppointment.appointment.customer.lastName).toBeUndefined();
    expect(home.body.rebook).toBeNull();
    expect(home.body.loyalty.badge).toBeNull();
    expect(Number.isInteger(home.body.loyalty.progressCents)).toBe(true);
    expect(home.body.favoriteShop.slug).toBeTruthy();
    expect(home.body.family).toEqual([]);

    const familyMod = await import("@/app/api/v1/me/family/route");
    const added = await json(
      await call(familyMod, "POST", "http://localhost/api/v1/me/family", {}, { method: "POST", headers: auth, body: JSON.stringify({ firstName: "Sam", birthYear: 2016 }) }),
    );
    expect(added.status).toBe(201);
    expect(added.body.member).toMatchObject({ firstName: "Sam", birthYear: 2016, guardianId: customerId });
    expect(added.body.member.lastName).toBeUndefined();
    const listed = await json(await call(familyMod, "GET", "http://localhost/api/v1/me/family", {}, { headers: auth }));
    expect(listed.body.members).toHaveLength(1);
    for (let n = 0; n < 5; n++) {
      const more = await json(
        await call(familyMod, "POST", "http://localhost/api/v1/me/family", {}, { method: "POST", headers: auth, body: JSON.stringify({ firstName: `Kid${n}` }) }),
      );
      expect(more.status).toBe(201);
    }
    const capped = await json(
      await call(familyMod, "POST", "http://localhost/api/v1/me/family", {}, { method: "POST", headers: auth, body: JSON.stringify({ firstName: "Extra" }) }),
    );
    expect(capped.status).toBe(400);
    expect(capped.body.error.code).toBe("bad_request");
    expect(capped.body.error.message).toBe("A profile can have up to 6 family members.");
    const familyDelete = await import("@/app/api/v1/me/family/[id]/route");
    const removed = await call(familyDelete, "DELETE", `http://localhost/api/v1/me/family/${added.body.member.id}`, { id: added.body.member.id }, { method: "DELETE", headers: auth });
    expect(removed.status).toBe(204);

    const liveMod = await import("@/app/api/v1/shops/[shop]/live/route");
    const live = await json(await call(liveMod, "GET", "http://localhost/api/v1/shops/coralville/live", { shop: "coralville" }));
    expect(live.status).toBe(200);
    expect(Number.isInteger(live.body.waitMinutes)).toBe(true);
    expect(Number.isInteger(live.body.chairsFree)).toBe(true);
    expect(live.body.chairsFree).toBeGreaterThanOrEqual(0);

    const setupMod = await import("@/app/api/v1/me/payment-methods/setup/route");
    const refused = await json(
      await call(setupMod, "POST", "http://localhost/api/v1/me/payment-methods/setup", {}, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ number: "4242424242424242", cvc: "123" }),
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Stripe/);
    const credit = await json(
      await call(setupMod, "POST", "http://localhost/api/v1/me/payment-methods/setup", {}, { method: "POST", headers: auth, body: JSON.stringify({ funding: "credit" }) }),
    );
    expect(credit.status).toBe(200);
    expect(credit.body.clientSecret).toMatch(/^seti_/);
    expect(credit.body.ephemeralKey).toMatch(/^ek_test_/);
    expect(credit.body.customerId).toMatch(/^cus_/);
    expect(credit.body.paymentMethod).toMatchObject({ brand: "visa", last4: "4242", funding: "credit", wallet: false });
    const debit = await json(
      await call(setupMod, "POST", "http://localhost/api/v1/me/payment-methods/setup", {}, { method: "POST", headers: auth, body: JSON.stringify({ funding: "debit" }) }),
    );
    expect(debit.body.paymentMethod).toMatchObject({ last4: "5556", funding: "debit" });
    const cardsMod = await import("@/app/api/v1/me/payment-methods/route");
    const cards = await json(await call(cardsMod, "GET", "http://localhost/api/v1/me/payment-methods", {}, { headers: auth }));
    expect(cards.body.paymentMethods.map((c: { id: string }) => c.id).sort()).toEqual([credit.body.paymentMethod.id, debit.body.paymentMethod.id].sort());
    expect(cards.body.paymentMethods.every((c: { customerId: string }) => c.customerId === customerId)).toBe(true);

    const previewMod = await import("@/app/api/v1/appointments/[code]/payment-preview/route");
    const creditPreview = await json(
      await call(previewMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-preview`, { code: booked.code }, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500, wallet: true }),
      }),
    );
    expect(creditPreview.body.feeCents).toBe(93);
    expect(creditPreview.body.feeLabel).toBe("Credit card surcharge (3%)");
    expect(creditPreview.body.disclosure).toMatch(/credit card/i);
    expect(creditPreview.body.taxCents).toBe(203);
    expect(creditPreview.body.totalCents).toBe(2900 + 203 + 500 + 93);
    expect(creditPreview.body.destination.model).toBe("separate_charges_and_transfers");
    expect(creditPreview.body.destination.serviceTransferCents).toBe(2900 + 203);
    expect(creditPreview.body.tipTransfer).toEqual({ amountCents: 500, disposition: "payroll", copy: "Tips paid through payroll." });
    expect(creditPreview.body.paidAt).toBeUndefined();
    const debitPreview = await json(
      await call(previewMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-preview`, { code: booked.code }, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ paymentMethodId: debit.body.paymentMethod.id, tipCents: 500 }),
      }),
    );
    expect(debitPreview.body.feeCents).toBe(0);
    expect(debitPreview.body.feeReason).toBe("not_credit");
    const lied = await json(
      await call(previewMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-preview`, { code: booked.code }, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500, wallet: true }),
      }),
    );
    expect(lied.body.feeCents).toBe(93);
    expect(lied.body.feeReason).toBe("applies");
    expect(lied.body.wallet).toBe(false);
    expect(lied.body.funding).toBe("credit");
    const walletCredit = await json(
      await call(previewMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-preview`, { code: booked.code }, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ paymentMethodId: "pm_card_applepay_visa", tipCents: 500, wallet: false }),
      }),
    );
    expect(walletCredit.body.feeReason).toBe("wallet_fee_off");
    expect(walletCredit.body.feeCents).toBe(0);
    expect(walletCredit.body.wallet).toBe(true);
    expect(walletCredit.body.funding).toBe("credit");
    process.env.FEATURE_WALLET_FEE = "true";
    try {
      const walletDebit = await json(
        await call(previewMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-preview`, { code: booked.code }, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ paymentMethodId: "pm_card_applepay_visa_debit", tipCents: 500, wallet: false }),
        }),
      );
      expect(walletDebit.body.feeCents).toBe(0);
      expect(walletDebit.body.feeReason).toBe("not_credit");
      expect(walletDebit.body.funding).toBe("debit");
      expect(walletDebit.body.wallet).toBe(true);
    } finally {
      delete process.env.FEATURE_WALLET_FEE;
    }

    const payMod = await import("@/app/api/v1/appointments/[code]/payments/route");
    const paid = await json(
      await call(payMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payments`, { code: booked.code }, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "pay-1" },
        body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500, wallet: true }),
      }),
    );
    expect(paid.status).toBe(200);
    expect(paid.body.feeCents).toBe(93);
    expect(paid.body.totalCents).toBe(creditPreview.body.totalCents);
    expect(paid.body.tender).toBe("card");
    expect(paid.body.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = await json(
      await call(payMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payments`, { code: booked.code }, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "pay-1" },
        body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500, wallet: true }),
      }),
    );
    expect(again.body.id).toBe(paid.body.id);
    expect(paid.body.wallet).toBe(false);
    const intentsAfterPay = m.processor.simulatorLedger().intents.length;
    const secondPay = await json(
      await call(payMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payments`, { code: booked.code }, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "pay-2" },
        body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500, wallet: true }),
      }),
    );
    expect(secondPay.body.id).toBe(paid.body.id);
    expect(m.processor.simulatorLedger().intents.length).toBe(intentsAfterPay);
    const splits = await m.db.db.select().from(m.schema.connectTransfers).where(eq(m.schema.connectTransfers.paymentIntentId, (await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, paid.body.id)))[0].stripePaymentIntentId!));
    expect(splits.some((row) => row.stripeTransferId?.startsWith("sim_tr_split_"))).toBe(false);
    expect(splits.find((row) => row.role === "tip")?.note).toContain("included in shop destination charge");
    const charged = (await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, paid.body.id)))[0];
    const intent = m.processor.simulatorLedger().intents.find((row) => row.id === charged.stripePaymentIntentId);
    expect(intent?.surchargeCents).toBe(93);
    expect(intent?.lineItems).toEqual([
      { productName: "Services", productCode: "services", unitCost: 2900 + 203 + 500, quantity: 1 },
      { productName: "Credit card surcharge (3%)", productCode: "surcharge", unitCost: 93, quantity: 1 },
    ]);

    const receiptsMod = await import("@/app/api/v1/me/receipts/route");
    const list = await json(await call(receiptsMod, "GET", "http://localhost/api/v1/me/receipts?limit=1", {}, { headers: auth }));
    expect(list.body.receipts).toHaveLength(1);
    expect(list.body.receipts[0]).toMatchObject({ id: paid.body.id, shopName: "Coralville", totalCents: paid.body.totalCents, serviceName: cut.name });
    expect(list.body.limit).toBe(1);
    expect(list.body.nextCursor).toBeNull();
    const detailMod = await import("@/app/api/v1/me/receipts/[id]/route");
    const detail = await json(await call(detailMod, "GET", `http://localhost/api/v1/me/receipts/${paid.body.id}`, { id: paid.body.id }, { headers: auth }));
    expect(detail.body.grossLabel).toBe("Gross receipt");
    expect(detail.body.serviceCents).toBe(2900);
    expect(detail.body.taxCents).toBe(203);
    expect(detail.body.tipCents).toBe(500);
    expect(detail.body.feeCents).toBe(93);
    expect(detail.body.feeLabel).toBe("Credit card surcharge (3%)");
    expect(detail.body.totalCents).toBe(paid.body.totalCents);
    expect(detail.body.tender).toBe("Visa ••4242");
    expect(detail.body.refunds).toEqual([]);
    const missing = await json(await call(detailMod, "GET", "http://localhost/api/v1/me/receipts/undefined", { id: "undefined" }, { headers: auth }));
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ receipt: null });
    expect(missing.text.toLowerCase()).not.toContain("rating");

    const [payRow] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, paid.body.id));
    await m.db.db.insert(m.schema.refunds).values({
      saleId: paid.body.id,
      paymentId: payRow.id,
      shopId: payRow.shopId,
      businessDate: payRow.businessDate,
      method: "card",
      amountCents: 100,
      serviceNetCents: 100,
      reason: "test",
    });
    const afterRefund = await json(await call(detailMod, "GET", `http://localhost/api/v1/me/receipts/${paid.body.id}`, { id: paid.body.id }, { headers: auth }));
    expect(afterRefund.body.totalCents).toBe(paid.body.totalCents);
    expect(afterRefund.body.serviceCents).toBe(2900);
    expect(afterRefund.body.refunds).toEqual([expect.objectContaining({ amountCents: 100, serviceCents: 100, from: "shop" })]);

    const rebookMod = await import("@/app/api/v1/appointments/[code]/rebook/route");
    const rebooked = await json(
      await call(rebookMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/rebook`, { code: booked.code }, { method: "POST", headers: auth }),
    );
    expect(rebooked.status).toBe(201);
    expect(rebooked.body.appointment.code).not.toBe(booked.code);
    expect(new Date(rebooked.body.appointment.startsAt).getTime()).toBeGreaterThan(new Date(booked.startsAt).getTime());
    expect(rebooked.body.appointment.barber.displayName).not.toMatch(/\s/);

    const cardDelete = await import("@/app/api/v1/me/payment-methods/[id]/route");
    const detached = await call(cardDelete, "DELETE", `http://localhost/api/v1/me/payment-methods/${debit.body.paymentMethod.id}`, { id: debit.body.paymentMethod.id }, { method: "DELETE", headers: auth });
    expect(detached.status).toBe(204);
    const cardsAfter = await json(await call(cardsMod, "GET", "http://localhost/api/v1/me/payment-methods", {}, { headers: auth }));
    expect(cardsAfter.body.paymentMethods.map((c: { id: string }) => c.id)).not.toContain(debit.body.paymentMethod.id);

    await m.db.db.execute(m.drizzle.sql`update shops set launch_at = '9999-12-31T00:00:00.000Z' where slug = 'coralville'`);
    const closedPreview = await json(
      await call(previewMod, "POST", `http://localhost/api/v1/appointments/${rebooked.body.appointment.code}/payment-preview`, { code: rebooked.body.appointment.code }, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 0 }),
      }),
    );
    expect(closedPreview.status).toBe(200);
    expect(closedPreview.body.paymentsEnabled).toBe(false);
    expect(closedPreview.body.unavailableCopy).toBe("Book with us at this shop the usual way.");
    const closedPay = await json(
      await call(payMod, "POST", `http://localhost/api/v1/appointments/${rebooked.body.appointment.code}/payments`, { code: rebooked.body.appointment.code }, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "pay-closed" },
        body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 0 }),
      }),
    );
    expect(closedPay.status).toBe(403);
    expect(closedPay.body.error.code).toBe("forbidden");
    expect(closedPay.body.error.details.reason).toBe("not_launched");
    const closedRebook = await json(
      await call(rebookMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/rebook`, { code: booked.code }, {
        method: "POST",
        headers: { ...auth, "idempotency-key": "rebook-closed" },
      }),
    );
    expect(closedRebook.status).toBe(403);
    expect(closedRebook.body.error.details.reason).toBe("not_launched");
    await m.db.db.execute(m.drizzle.sql`update shops set launch_at = '2000-01-01T00:00:00.000Z' where slug = 'coralville'`);

    const meMod = await import("@/app/api/v1/me/route");
    const me = await json(await call(meMod, "GET", "http://localhost/api/v1/me", {}, { headers: auth }));
    expect(me.status).toBe(200);
    expect(me.body.lastName).toBe("Reyes");
    expect(me.body.smsOptIn).toBe(false);
    const missingVersion = await json(
      await call(meMod, "PATCH", "http://localhost/api/v1/me", {}, { method: "PATCH", headers: auth, body: JSON.stringify({ smsOptIn: true }) }),
    );
    expect(missingVersion.status).toBe(400);
    expect(missingVersion.body.error.message).toMatch(/consentTextVersion/);
    const optedIn = await json(
      await call(meMod, "PATCH", "http://localhost/api/v1/me", {}, { method: "PATCH", headers: auth, body: JSON.stringify({ smsOptIn: true, consentTextVersion: "2026-10-a" }) }),
    );
    expect(optedIn.body.smsOptIn).toBe(true);
    const optedOut = await json(
      await call(meMod, "PATCH", "http://localhost/api/v1/me", {}, { method: "PATCH", headers: auth, body: JSON.stringify({ smsOptIn: false }) }),
    );
    expect(optedOut.body.smsOptIn).toBe(false);
    const optedBack = await json(
      await call(meMod, "PATCH", "http://localhost/api/v1/me", {}, { method: "PATCH", headers: auth, body: JSON.stringify({ smsOptIn: true, consentTextVersion: "2026-10-b" }) }),
    );
    expect(optedBack.body.smsOptIn).toBe(true);
    const events = await m.db.db.select().from(m.schema.consentEvents).where(eq(m.schema.consentEvents.customerId, customerId));
    expect(events.filter((row) => row.channel === "sms_transactional" && row.action === "granted")).toHaveLength(2);
    expect(events.some((row) => row.channel === "sms_transactional" && row.action === "revoked")).toBe(true);

    const optOut = await m.db.db.update(m.schema.customers).set({ smsOptIn: false }).where(eq(m.schema.customers.id, customerId)).returning({ smsOptIn: m.schema.customers.smsOptIn });
    expect(optOut[0].smsOptIn).toBe(false);
    const startMod = await import("@/app/api/v1/me/delete/start/route");
    const started = await json(await call(startMod, "POST", "http://localhost/api/v1/me/delete/start", {}, { method: "POST", headers: auth }));
    expect(started.body.consequences).toContain("Receipts stay in the shop's books without your name.");
    expect(started.body.devCode).toMatch(/^\d{6}$/);
    const confirmMod = await import("@/app/api/v1/me/delete/confirm/route");
    const wrong = await json(
      await call(confirmMod, "POST", "http://localhost/api/v1/me/delete/confirm", {}, { method: "POST", headers: auth, body: JSON.stringify({ code: "000000" }) }),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("unauthorized");
    expect(wrong.body.error.message).toBe("That code didn't match.");
    const confirmed = await json(
      await call(confirmMod, "POST", "http://localhost/api/v1/me/delete/confirm", {}, { method: "POST", headers: auth, body: JSON.stringify({ code: started.body.devCode }) }),
    );
    expect(confirmed.body).toEqual({ deleted: true });
    const [gone] = await m.db.db.select().from(m.schema.customers).where(eq(m.schema.customers.id, customerId));
    expect(gone.deletedAt).toBeTruthy();
    expect(gone.phone).toBeNull();
    expect(gone.smsOptIn).toBe(false);
    expect(gone.firstName).toBe("Deleted");
    const [sale] = await m.db.db.select().from(m.schema.sales).where(eq(m.schema.sales.id, paid.body.id));
    expect(sale.status).toBe("paid");
    expect(sale.totalCents).toBe(paid.body.totalCents);
    const still = await json(await call(meMod, "GET", "http://localhost/api/v1/me", {}, { headers: auth }));
    expect(still.status).toBe(401);
  });

  it("records a confirmed PaymentIntent, reprices a different card, and does not charge twice", async () => {
    const services = await m.public.publicServices("coralville");
    const cut = services.services.find((s) => s.slug === "rayz-cut")!;
    const book = async (phone: string) => {
      let slot: { startsAt: string; barberIds: string[] } | undefined;
      for (let i = 4; i < 21 && !slot; i++) {
        const day = await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(m.time.todayLocal(), i), serviceId: cut.id, barberRef: "any" });
        slot = day.slots.find((s) => s.barberIds.length > 0);
      }
      if (!slot) throw new Error("no slots");
      return m.booking.createAppointment({
        shopRef: "coralville",
        serviceId: cut.id,
        barberRef: slot.barberIds[0],
        startsAt: slot.startsAt,
        customer: { firstName: "Alex", lastName: "Reyes", phone },
        source: "api",
        actor,
      });
    };
    const booked = await book("3195550192");
    const token = (await m.auth.issueTokens(booked.customer!.id, null)).accessToken;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const payMod = await import("@/app/api/v1/appointments/[code]/payments/route");
    const previewMod = await import("@/app/api/v1/appointments/[code]/payment-preview/route");
    const preview = await json(
      await call(previewMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payment-preview`, { code: booked.code }, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ paymentMethodId: "pm_card_visa", tipCents: 500 }),
      }),
    );
    const debitTotal = 2900 + 203 + 500;
    expect(preview.body.totalCents).toBe(debitTotal + 93);
    const accountId = preview.body.destination.shopAccountId as string;
    expect(accountId).toBeTruthy();
    const before = m.processor.simulatorLedger().intents.length;
    const confirmed = await m.processor.chargeCard({
      paymentMethodId: "pm_card_applepay_visa_debit",
      amountCents: debitTotal,
      description: "PaymentSheet",
      metadata: { appointmentId: booked.id, code: booked.code },
      idempotencyKey: `sheet-${booked.code}`,
      destination: { accountId, applicationFeeCents: 50 },
    });
    expect(m.processor.simulatorLedger().intents.length).toBe(before + 1);
    process.env.FEATURE_WALLET_FEE = "true";
    let paid: { status: number; body: { id: string; feeCents: number; feeReason: string; wallet: boolean; funding: string; totalCents: number } };
    try {
      paid = await json(
        await call(payMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payments`, { code: booked.code }, {
          method: "POST",
          headers: { ...auth, "idempotency-key": `sheet-pay-${booked.code}` },
          body: JSON.stringify({ paymentMethodId: "pm_card_visa", tipCents: 500, wallet: true, paymentIntentId: confirmed.paymentIntentId }),
        }),
      );
    } finally {
      delete process.env.FEATURE_WALLET_FEE;
    }
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.feeCents).toBe(0);
    expect(paid.body.feeReason).toBe("not_credit");
    expect(paid.body.wallet).toBe(true);
    expect(paid.body.funding).toBe("debit");
    expect(paid.body.totalCents).toBe(debitTotal);
    expect(m.processor.simulatorLedger().intents.length).toBe(before + 1);
    const [row] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, paid.body.id));
    expect(row.stripePaymentIntentId).toBe(confirmed.paymentIntentId);
    expect(row.cardFeeCents).toBe(0);
    const splits = await m.db.db.select().from(m.schema.connectTransfers).where(eq(m.schema.connectTransfers.paymentIntentId, confirmed.paymentIntentId));
    expect(splits.some((r) => r.stripeTransferId?.startsWith("sim_tr_split_"))).toBe(false);

    const decoy = await m.processor.chargeCard({
      paymentMethodId: "pm_card_visa",
      amountCents: debitTotal + 93,
      description: "already paid",
      metadata: { appointmentId: booked.id, code: booked.code },
      idempotencyKey: `sheet-again-${booked.code}`,
      destination: { accountId, applicationFeeCents: 50 },
      surchargeCents: 93,
    });
    const afterDecoy = m.processor.simulatorLedger().intents.length;
    const second = await json(
      await call(payMod, "POST", `http://localhost/api/v1/appointments/${booked.code}/payments`, { code: booked.code }, {
        method: "POST",
        headers: { ...auth, "idempotency-key": `sheet-pay-again-${booked.code}` },
        body: JSON.stringify({ paymentMethodId: "pm_card_visa", tipCents: 500, paymentIntentId: decoy.paymentIntentId }),
      }),
    );
    expect(second.body.id).toBe(paid.body.id);
    expect(m.processor.simulatorLedger().intents.length).toBe(afterDecoy);
    const sales = await m.db.db.select().from(m.schema.sales).where(eq(m.schema.sales.appointmentId, booked.id));
    expect(sales.filter((s) => s.status === "paid")).toHaveLength(1);

    const other = await book("3195550193");
    const otherToken = (await m.auth.issueTokens(other.customer!.id, null)).accessToken;
    const otherAuth = { authorization: `Bearer ${otherToken}`, "content-type": "application/json" };
    const badIntent = await m.processor.chargeCard({
      paymentMethodId: "pm_card_visa",
      amountCents: 1000,
      description: "wrong amount",
      metadata: { appointmentId: other.id, code: other.code },
      idempotencyKey: `bad-${other.code}`,
      destination: { accountId, applicationFeeCents: 10 },
    });
    const afterBad = m.processor.simulatorLedger().intents.length;
    const bad = await json(
      await call(payMod, "POST", `http://localhost/api/v1/appointments/${other.code}/payments`, { code: other.code }, {
        method: "POST",
        headers: { ...otherAuth, "idempotency-key": `bad-pay-${other.code}` },
        body: JSON.stringify({ paymentMethodId: "pm_card_visa", tipCents: 500, paymentIntentId: badIntent.paymentIntentId }),
      }),
    );
    expect(bad.status).toBe(402);
    expect(bad.body.error.code).toBe("payment_failed");
    expect(bad.body.error.message).toMatch(/doesn't match/);
    expect(m.processor.simulatorLedger().intents.length).toBe(afterBad);
    const otherSales = await m.db.db.select().from(m.schema.sales).where(eq(m.schema.sales.appointmentId, other.id));
    expect(otherSales).toHaveLength(0);
  });
});
