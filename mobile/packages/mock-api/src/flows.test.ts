import { describe, expect, it } from "vitest";
import { GROSS_LABEL, PARTIAL_WEEK_OT_LABEL, PAYOUT_STATUS_LABEL, TRANSFER_STATUS_LABEL } from "@rayz/api";
import { createApp } from "./http";
import { derivePayoutState, flagsForState } from "./payout";
import { SHOP_CORALVILLE, SHOP_KIMBERLY, STAFF_CASEY, STAFF_MAKENNA } from "./fixtures";

async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}

async function staffSession(app: ReturnType<typeof createApp>, phone = "+13195550111", pin = "135790") {
  const verified = await json(await app.request("/api/staff/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, code: "123456" }), headers: { "content-type": "application/json" } }));
  const step = await json(await app.request("/api/staff/v1/auth/step-up", { method: "POST", body: JSON.stringify({ pin }), headers: { "content-type": "application/json", authorization: `Bearer ${verified.body.accessToken}` } }));
  return { token: verified.body.accessToken as string, stepUp: step.body.stepUpToken as string };
}

describe("customer flows", () => {
  it("signs in a shared family phone and books", async () => {
    const app = createApp();
    const started = await json(await app.request("/api/v1/auth/otp/start", { method: "POST", body: JSON.stringify({ phone: "3195550100" }), headers: { "content-type": "application/json" } }));
    expect(started.body.devCode).toBe("123456");
    const choice = await json(await app.request("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone: "+13195550100", code: "123456" }), headers: { "content-type": "application/json" } }));
    expect(choice.body.chooseProfile).toBe(true);
    expect(choice.body.profiles.map((p: { firstName: string }) => p.firstName).sort()).toEqual(["Alex", "Jordan"]);
    const done = await json(await app.request("/api/v1/auth/otp/complete", { method: "POST", body: JSON.stringify({ selectionToken: choice.body.selectionToken, customerId: choice.body.profiles[0].id }), headers: { "content-type": "application/json" } }));
    expect(done.body.accessToken).toContain("cust.");
    const auth = { authorization: `Bearer ${done.body.accessToken}`, "content-type": "application/json" };
    const booked = await json(await app.request("/api/v1/appointments", { method: "POST", headers: { ...auth, "idempotency-key": "book-1" }, body: JSON.stringify({ shopId: "coralville", serviceId: "svc-cut", startsAt: "2026-10-26T16:00:00.000Z" }) }));
    expect(booked.status).toBe(201);
    const again = await json(await app.request("/api/v1/appointments", { method: "POST", headers: { ...auth, "idempotency-key": "book-1" }, body: JSON.stringify({ shopId: "coralville", serviceId: "svc-cut", startsAt: "2026-10-26T16:00:00.000Z" }) }));
    expect(again.body.appointment.code).toBe(booked.body.appointment.code);
    const external = await json(await app.request("/api/v1/appointments", { method: "POST", headers: auth, body: JSON.stringify({ shopId: "kimberly", serviceId: "svc-cut", startsAt: "2026-10-26T16:00:00.000Z" }) }));
    expect(external.status).toBe(409);
    expect(external.body.error.details.externalBookingUrl).toContain("/shops/kimberly");
  });

  it("shows the card fee before a credit charge and waives debit and wallet", async () => {
    const app = createApp();
    const auth = { authorization: "Bearer cust.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "content-type": "application/json" };
    const credit = await json(await app.request("/api/v1/me/payment-methods/setup", { method: "POST", headers: auth, body: JSON.stringify({ funding: "credit" }) }));
    const debit = await json(await app.request("/api/v1/me/payment-methods/setup", { method: "POST", headers: auth, body: JSON.stringify({ funding: "debit" }) }));
    const creditPreview = await json(await app.request("/api/v1/appointments/NEXT4ALEX01/payment-preview", { method: "POST", headers: auth, body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500 }) }));
    expect(creditPreview.body.feeCents).toBe(93);
    expect(creditPreview.body.feeLabel).toMatch(/3%/);
    expect(creditPreview.body.disclosure).toMatch(/before|credit card/i);
    expect(creditPreview.body.totalCents).toBe(2900 + 203 + 500 + 93);
    expect(creditPreview.body.destination.model).toBe("separate_charges_and_transfers");
    expect(creditPreview.body.tipTransfer).toEqual({ amountCents: 500, disposition: "payroll", copy: "Tips paid through payroll." });
    const debitPreview = await json(await app.request("/api/v1/appointments/NEXT4ALEX01/payment-preview", { method: "POST", headers: auth, body: JSON.stringify({ paymentMethodId: debit.body.paymentMethod.id, tipCents: 500 }) }));
    expect(debitPreview.body.feeCents).toBe(0);
    expect(debitPreview.body.feeReason).toBe("not_credit");
    const wallet = await json(await app.request("/api/v1/appointments/NEXT4ALEX01/payment-preview", { method: "POST", headers: auth, body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500, wallet: true }) }));
    expect(wallet.body.feeReason).toBe("wallet_fee_off");
    const debitIntent = await json(await app.request("/api/v1/appointments/NEXT4ALEX01/payment-intents", { method: "POST", headers: auth, body: JSON.stringify({ paymentMethodId: debit.body.paymentMethod.id, tipCents: 500 }) }));
    expect(debitIntent.body.clientSecret).toMatch(/^pi_/);
    expect(debitIntent.body.feeCents).toBe(0);
    expect(debitIntent.body.paymentMethodId).toBe(debit.body.paymentMethod.id);
    const chargedDebit = await json(await app.request("/api/v1/appointments/NEXT4ALEX01/payments", { method: "POST", headers: auth, body: JSON.stringify({ paymentIntentId: debitIntent.body.id, paymentMethodId: credit.body.paymentMethod.id, tipCents: 0 }) }));
    expect(chargedDebit.body.feeCents).toBe(0);
    expect(chargedDebit.body.paymentMethodId).toBe(debit.body.paymentMethod.id);
    expect(chargedDebit.body.tender).toContain("5556");
    expect(chargedDebit.body.tender).not.toContain("4242");
    const creditIntent = await json(await app.request("/api/v1/appointments/NEXT4ALEX01/payment-intents", { method: "POST", headers: auth, body: JSON.stringify({ paymentMethodId: credit.body.paymentMethod.id, tipCents: 500 }) }));
    expect(creditIntent.body.feeCents).toBe(93);
    const paid = await json(await app.request("/api/v1/appointments/NEXT4ALEX01/payments", { method: "POST", headers: auth, body: JSON.stringify({ paymentIntentId: creditIntent.body.id }) }));
    expect(paid.body.feeCents).toBe(93);
    expect(paid.body.paymentMethodId).toBe(credit.body.paymentMethod.id);
    expect(paid.body.totalCents).toBe(creditPreview.body.totalCents);
    expect(paid.body.tender).toContain("4242");
  });
});

describe("staff pay, clock, and earnings", () => {
  it("walks every payout state and keeps instant fees off the tip", async () => {
    for (const state of ["not_started", "in_progress", "pending_verification", "requirements_due", "restricted", "active", "rejected"] as const) {
      expect(derivePayoutState(flagsForState(state))).toBe(state);
    }
    const app = createApp();
    const session = await staffSession(app, "+13195550444", "101010");
    const auth = { authorization: `Bearer ${session.token}`, "content-type": "application/json", "x-step-up": session.stepUp };
    expect((await app.request("/api/staff/v1/me/payout-account", { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(403);
    expect((await app.request("/api/staff/v1/me/payout-account/session", { method: "POST", headers: { authorization: `Bearer ${session.token}` } })).status).toBe(403);
    expect((await json(await app.request("/api/staff/v1/me/payout-account", { headers: auth }))).body.account.state).toBe("not_started");
    const moved = await json(await app.request("/api/staff/v1/me/payout-account/session/complete", { method: "POST", headers: auth, body: JSON.stringify({ state: "active" }) }));
    expect(moved.body.state).toBe("active");
    const quote = await json(await app.request("/api/staff/v1/me/instant-payouts/quote", { method: "POST", headers: auth, body: JSON.stringify({ amountCents: 1000 }) }));
    expect(quote.body.deductedFromTipsCents).toBe(0);
    expect(quote.body.feeCents).toBeGreaterThan(0);
    expect(quote.body.amountCents).toBe(1000);
  });

  it("clocks in with a rotating code and requires a cash-tip attestation", async () => {
    const app = createApp();
    const { token } = await staffSession(app);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const barber = await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: auth });
    expect(barber.status).toBe(403);
    const missing = await app.request("/api/staff/v1/kiosk/qr?shopId=coralville");
    expect(missing.status).toBe(401);
    const unsigned = await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: { authorization: `Bearer kiosk.${SHOP_CORALVILLE}` } });
    expect(unsigned.status).toBe(401);
    const paired = await json(await app.request("/api/staff/v1/kiosk/pair", { method: "POST", headers: auth, body: JSON.stringify({ shopId: SHOP_CORALVILLE }) }));
    expect(paired.status).toBe(201);
    const device = { authorization: `Bearer ${paired.body.credential}` };
    const code = await json(await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: device }));
    expect(code.status).toBe(200);
    expect(code.body.rotatesSeconds).toBe(15);
    expect(String(code.body.token).split(".")).toHaveLength(5);
    const otherShop = await app.request("/api/staff/v1/kiosk/qr?shopId=moline", { headers: device });
    expect(otherShop.status).toBe(404);
    const blocked = await app.request("/api/staff/v1/kiosk/pair", { method: "POST", headers: auth, body: JSON.stringify({ shopId: SHOP_KIMBERLY }) });
    expect(blocked.status).toBe(409);
    const bio = await json(await app.request("/api/staff/v1/clock/in", { method: "POST", headers: auth, body: JSON.stringify({ token: code.body.token, biometric: true }) }));
    expect(bio.status).toBe(400);
    const inn = await json(await app.request("/api/staff/v1/clock/in", { method: "POST", headers: auth, body: JSON.stringify({ token: code.body.token }) }));
    expect(inn.status).toBe(200);
    const reuse = await json(await app.request("/api/staff/v1/clock/out", { method: "POST", headers: auth, body: JSON.stringify({ token: code.body.token, cashTipCents: 0 }) }));
    expect(reuse.status).toBe(400);
    const outCode = await json(await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: device }));
    const noAttest = await json(await app.request("/api/staff/v1/clock/out", { method: "POST", headers: auth, body: JSON.stringify({ token: outCode.body.token, cashTipCents: 1200 }) }));
    expect(noAttest.status).toBe(422);
    const fresh = await json(await app.request("/api/staff/v1/kiosk/qr?shopId=coralville", { headers: device }));
    const out = await json(await app.request("/api/staff/v1/clock/out", { method: "POST", headers: auth, body: JSON.stringify({ token: fresh.body.token, cashTipCents: 1200, attestation: true }) }));
    expect(out.body.punch.cashTipCents).toBe(1200);
    expect(out.body.punch.attestation).toBe(true);
    const remotePin = await app.request("/api/staff/v1/kiosk/pin", { method: "POST", headers: auth, body: JSON.stringify({ pin: "135790", direction: "in" }) });
    expect(remotePin.status).toBe(403);
    const onKiosk = await json(await app.request("/api/staff/v1/kiosk/pin", { method: "POST", headers: { authorization: `Bearer ${paired.body.credential}`, "content-type": "application/json" }, body: JSON.stringify({ pin: "135790", direction: "in" }) }));
    expect(onKiosk.status).toBe(200);
    expect(onKiosk.body.punch.shopId).toBe(SHOP_CORALVILLE);
  });

  it("serves gross earnings only to the signed-in barber", async () => {
    const app = createApp();
    const makenna = await staffSession(app);
    const headers = { authorization: `Bearer ${makenna.token}`, "x-step-up": makenna.stepUp };
    const lockedOut = await app.request("/api/staff/v1/me/earnings?period=current", { headers: { authorization: `Bearer ${makenna.token}` } });
    expect(lockedOut.status).toBe(403);
    const other = await app.request("/api/staff/v1/me/earnings?period=current&staffId=" + STAFF_CASEY, { headers });
    expect(other.status).toBe(400);
    const current = await json(await app.request("/api/staff/v1/me/earnings?period=current", { headers }));
    expect(current.body.grossLabel).toBe(GROSS_LABEL);
    expect(current.body.from).toBe("2026-10-18");
    expect(current.body.periods.map((p: { payrollStatus: string }) => p.payrollStatus)).toContain("not_yet_processed");
    expect(JSON.stringify(current.body).toLowerCase()).not.toContain("isolved");
    expect(current.body.netPayCents).toBeUndefined();

    const week = await json(await app.request("/api/staff/v1/me/earnings?from=2026-10-11&to=2026-10-17", { headers }));
    expect(week.body.workweeks.find((w: { weekStart: string }) => w.weekStart === "2026-10-18")).toBeUndefined();
    const trainingWeek = week.body.workweeks.find((w: { weekStart: string }) => w.weekStart === "2026-10-11");
    expect(trainingWeek.otHours).toBe(2);
    expect(trainingWeek.trainingHours).toBe(4);
    expect(trainingWeek.productionHours).toBe(38);
    expect(week.body.trainingPayCents).toBe(4800);
    expect(week.body.greaterOfCents).toBe(36 * 1500);
    expect(week.body.otEstimatedCents).toBe(2 * 1.5 * 1500);
    expect(week.body.periods).toHaveLength(1);

    const clipped = await json(await app.request("/api/staff/v1/me/earnings?from=2026-10-16&to=2026-10-20", { headers }));
    expect(clipped.body.workweeks.filter((w: { partial: boolean }) => w.partial).every((w: { otLabel: string }) => w.otLabel === PARTIAL_WEEK_OT_LABEL)).toBe(true);

    const tickets = await json(await app.request("/api/staff/v1/me/earnings/tickets?from=2026-10-19&to=2026-10-25", { headers }));
    const transfers = new Set(tickets.body.tickets.map((t: { transfer: { status: string } | null }) => t.transfer?.status).filter(Boolean));
    const payoutStatuses = new Set(tickets.body.tickets.map((t: { payout: { status: string } | null }) => t.payout?.status).filter(Boolean));
    expect([...transfers].sort()).toEqual(Object.keys(TRANSFER_STATUS_LABEL).sort());
    expect([...payoutStatuses].sort()).toEqual(Object.keys(PAYOUT_STATUS_LABEL).sort());
    expect(JSON.stringify(tickets.body)).not.toMatch(/phone|email|notes/);
    expect(tickets.body.tickets.every((t: { clientFirstName: string }) => t.clientFirstName && !t.clientFirstName.includes(" "))).toBe(true);

    const days = await json(await app.request("/api/staff/v1/me/earnings/days?from=2026-10-19&to=2026-10-25", { headers }));
    expect(days.body.days.reduce((n: number, d: { cardTipsCents: number }) => n + d.cardTipsCents, 0)).toBe(current.body.cardTipsCents);

    const casey = await staffSession(app, "+15635550333", "111222");
    const caseyBody = await json(await app.request("/api/staff/v1/me/earnings?from=2026-10-19&to=2026-10-25", { headers: { authorization: `Bearer ${casey.token}`, "x-step-up": casey.stepUp } }));
    expect(caseyBody.body.shops).toHaveLength(2);
    expect(JSON.stringify(caseyBody.body)).not.toContain("sale_pending");
    expect(JSON.stringify(tickets.body)).not.toContain("sale_casey");
    expect(casey.token).not.toContain(STAFF_MAKENNA);

    const report = await app.request("/api/staff/v1/me/earnings/report?from=2026-09-20&to=2026-10-03&format=csv", { headers });
    const csv = await report.text();
    expect(csv.startsWith(GROSS_LABEL)).toBe(true);
    expect(csv.toLowerCase()).not.toContain("isolved");
    expect(csv.toLowerCase()).not.toContain("net pay");
  });
});
