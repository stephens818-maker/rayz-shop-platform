/**
 * Digital receipts against a real database: the counter's text/email/no-receipt choice, what's on
 * file shown masked to staff who can't see it, the branded receipt page (no card number, no contact
 * details), updated receipts after refunds and voids, consent and opt-outs, staff resends and
 * clients asking for copies.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let R: typeof import("@/server/receipts");
let privacy: typeof import("@/server/client-privacy");
const fx = { shopId: "", michelle: "", cutId: "" };
let seq = 0;

beforeAll(async () => {
  m = await loadModules();
  R = await import("@/server/receipts");
  privacy = await import("@/server/client-privacy");
  const shop = (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "coralville") }))!;
  fx.shopId = shop.id;
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.displayLabel, "Michelle") }))!.id;
  const menu = await m.catalog.shopCatalog(shop.id);
  fx.cutId = (menu.find((s) => s.slug === "rayz-cut-shampoo") ?? menu.find((s) => s.kind === "service")!).id;
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

/** A paid ticket for a new client with a phone and email on file. */
async function paidTicket(o: { smsOptIn?: boolean; emailOptIn?: boolean; card?: string } = {}) {
  const n = String(1000 + ++seq + Math.floor(Math.random() * 8000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: "Riley", lastName: "Receipt", phone: `+1712555${n}`, email: `riley${n}@example.com`, smsOptIn: !!o.smsOptIn, emailOptIn: !!o.emailOptIn })
    .returning();
  const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.michelle);
  await m.db.db.update(s().sales).set({ customerId: c.id }).where(eq(s().sales.id, sale.id));
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [{ kind: "service", refId: fx.cutId, qty: 1 }],
    tipCents: 600,
    tender: { method: "card", paymentMethodId: o.card ?? "pm_card_visa", entryMode: "keyed" },
    actor,
  });
  return { saleId: sale.id, customer: c };
}

const deliveries = (saleId: string) => m.db.db.select().from(s().receiptDeliveries).where(eq(s().receiptDeliveries.saleId, saleId)).orderBy(s().receiptDeliveries.createdAt);
const job = async (id: string | null) => (await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.id, id!)))[0];
const tokenIn = (body: string) => body.match(/\/receipt\/([A-Za-z0-9_-]{43})/)![1];
const staffActor = () => ({ staffId: fx.michelle, label: "Michelle" });

function policy(levels: Record<string, "full" | "masked" | "hidden">) {
  return privacy.makePolicy({ staffId: fx.michelle, isOwner: false, canReveal: false, custom: [], levels: new Map(Object.entries(levels)) as never });
}

describe("digital receipts", () => {
  it("asks at the counter with what's on file masked, texts a link, and the page shows the ticket without card or contact details", async () => {
    const { saleId, customer } = await paidTicket();
    await m.db.db
      .update(s().shops)
      .set({ receipt: { reviewUrl: "https://g.page/r/rayz-coralville/review", reviewMinVisits: 1 } })
      .where(eq(s().shops.id, fx.shopId));

    const st = await R.saleReceiptState(saleId, policy({ phone: "hidden", email: "masked" }));
    expect(st.atCheckout).toBe(true);
    expect(st.onFile.phone).toBe(`***-***-${customer.phone!.slice(-4)}`);
    expect(st.onFile.email).toMatch(/^r\*\*\*@example\.com$/);
    expect(JSON.stringify(st)).not.toContain(customer.phone!.slice(2, 8));
    expect((await R.saleReceiptState(saleId, policy({ phone: "full", email: "full" }))).onFile.email).toBe(customer.email);

    const sent = await R.sendReceiptFromStaff(saleId, { channel: "sms", onFile: true, atCheckout: true }, staffActor());
    expect(sent).toEqual({ status: "queued", masked: `***-***-${customer.phone!.slice(-4)}` });
    const [d] = await deliveries(saleId);
    expect(d).toMatchObject({ purpose: "counter", channel: "sms", destination: customer.phone, sentBy: fx.michelle });
    const text = await job(d.jobId);
    expect(text).toMatchObject({ kind: "receipt", channel: "sms", to: customer.phone, status: "pending" });
    expect(text.body).toMatch(/STOP/);
    expect(text.body.length).toBeLessThan(300);
    expect((await R.saleReceiptState(saleId, policy({}))).atCheckout).toBe(false);

    const page = await R.resolveReceipt(tokenIn(text.body));
    expect(page.state).toBe("ok");
    if (page.state !== "ok") return;
    const data = page.data;
    expect(data.barber).toBe("Michelle");
    expect(data.firstName).toBe("Riley");
    expect(data.tipCents).toBe(600);
    expect(data.fee?.label).toMatch(/surcharge/);
    expect(data.tenders).toEqual([{ label: "Visa •••• 4242", cents: data.totalCents }]);
    expect(data.lines).toHaveLength(1);
    expect(data.rebookUrl).toMatch(/^\/book\/coralville\?barber=[a-z0-9-]+&service=/);
    expect(data.reviewUrl).toBe("https://g.page/r/rayz-coralville/review");
    const json = JSON.stringify(data);
    expect(json).not.toContain(customer.phone!);
    expect(json).not.toContain(customer.email!);
    expect(json).not.toContain("Receipt");
    expect(json).not.toMatch(/pm_|pi_|fingerprint/);
    expect((await R.resolveReceipt("not-a-token")).state).toBe("unknown");
    expect((await R.resolveReceipt("A".repeat(43))).state).toBe("unknown");
    await m.db.db.update(s().shops).set({ receipt: {} }).where(eq(s().shops.id, fx.shopId));
  });

  it("sends the updated receipt after a refund and after a void, to where the client chose", async () => {
    const { saleId, customer } = await paidTicket();
    await R.sendReceiptFromStaff(saleId, { channel: "email", onFile: true, atCheckout: true }, staffActor());
    const item = (await m.checkout.refundableState(saleId)).items[0];
    const out = await m.checkout.refundSale({ saleId, items: [], tipCents: 200, refundCardFee: false, reason: "Tip entered wrong", restock: false, actor });
    expect(out.refundedCents).toBe(200);
    let rows = await deliveries(saleId);
    expect(rows.map((r) => r.purpose)).toEqual(["counter", "refund"]);
    const update = await job(rows[1].jobId);
    expect(update).toMatchObject({ channel: "email", to: customer.email });
    expect(update.subject).toMatch(/^Updated receipt/);
    expect(update.body).toContain("$2.00 was refunded");
    const page = await R.resolveReceipt(tokenIn(update.body));
    expect(page.state === "ok" && page.data.refundedCents).toBe(200);
    // The first link shows the refund too.
    const first = await R.resolveReceipt(tokenIn((await job(rows[0].jobId)).body));
    expect(first.state === "ok" && first.data.refunds[0].label).toBe("Refunded to Visa •••• 4242");

    await m.checkout.refundSale({ saleId, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: true, reason: "Unhappy", restock: false, actor });
    rows = await deliveries(saleId);
    expect(rows.map((r) => r.purpose)).toEqual(["counter", "refund", "refund"]);

    const v = await paidTicket();
    await R.sendReceiptFromStaff(v.saleId, { channel: "sms", onFile: true, atCheckout: true }, staffActor());
    await m.checkout.voidSale(v.saleId, "Rang up the wrong client", actor);
    const vrows = await deliveries(v.saleId);
    expect(vrows.map((r) => r.purpose)).toEqual(["counter", "void"]);
    expect((await job(vrows[1].jobId)).body).toMatch(/voided/);
    const vp = await R.resolveReceipt(tokenIn((await job(vrows[1].jobId)).body));
    expect(vp.state === "ok" && vp.data.sale.status).toBe("voided");
  });

  it("sends nothing after a refund when the client wanted no receipt", async () => {
    const { saleId } = await paidTicket();
    await R.sendReceiptFromStaff(saleId, { channel: "none", onFile: false, atCheckout: true }, staffActor());
    await expect(R.sendReceiptFromStaff(saleId, { channel: "none", onFile: false }, staffActor())).rejects.toThrow(/text or email/);
    await m.checkout.refundSale({ saleId, items: [], tipCents: 100, refundCardFee: false, reason: "Tip", restock: false, actor });
    expect((await deliveries(saleId)).map((r) => [r.purpose, r.channel])).toEqual([["counter", "none"]]);
  });

  it("respects consent and opt-outs: STOP blocks texts, staff resends to what's on file need the client's agreement", async () => {
    const a = await paidTicket();
    // Not asked at checkout, never chose email, hasn't agreed to emails.
    await expect(R.sendReceiptFromStaff(a.saleId, { channel: "email", onFile: true }, staffActor())).rejects.toThrow(/hasn't agreed to emails/);
    // A destination the client gives staff is the client asking.
    await expect(R.sendReceiptFromStaff(a.saleId, { channel: "email", onFile: false, to: "Riley.New@Example.com" }, staffActor())).resolves.toMatchObject({ status: "queued" });
    expect((await deliveries(a.saleId)).at(-1)).toMatchObject({ purpose: "resend", destination: "riley.new@example.com" });

    const b = await paidTicket({ emailOptIn: true });
    await expect(R.sendReceiptFromStaff(b.saleId, { channel: "email", onFile: true }, staffActor())).resolves.toMatchObject({ status: "queued" });

    const c = await paidTicket({ smsOptIn: true });
    await m.db.db.insert(s().contactOptOuts).values({ phone: c.customer.phone!, channel: "sms", source: "reply" });
    const st = await R.saleReceiptState(c.saleId, policy({ phone: "masked" }));
    expect(st.onFile.smsStopped).toBe(true);
    await expect(R.sendReceiptFromStaff(c.saleId, { channel: "sms", onFile: true, atCheckout: true }, staffActor())).rejects.toThrow(/replied STOP/);
    await expect(R.sendReceiptFromStaff(c.saleId, { channel: "sms", onFile: false, to: c.customer.phone! }, staffActor())).rejects.toThrow(/replied STOP/);

    // Chose a text at checkout, then replied STOP: the refund update is recorded as not sent.
    const d = await paidTicket();
    await R.sendReceiptFromStaff(d.saleId, { channel: "sms", onFile: true, atCheckout: true }, staffActor());
    await m.db.db.insert(s().contactOptOuts).values({ phone: d.customer.phone!, channel: "sms", source: "reply" });
    await m.checkout.refundSale({ saleId: d.saleId, items: [], tipCents: 100, refundCardFee: false, reason: "Tip", restock: false, actor });
    expect((await deliveries(d.saleId)).at(-1)).toMatchObject({ purpose: "refund", skipped: "opted_out", jobId: null, tokenHash: null });
  });

  it("turns receipt emails off from the page, and they aren't offered or sent after", async () => {
    const { saleId, customer } = await paidTicket({ emailOptIn: true });
    await R.sendReceiptFromStaff(saleId, { channel: "email", onFile: true, atCheckout: true }, staffActor());
    const token = tokenIn((await job((await deliveries(saleId))[0].jobId)).body);
    await R.stopReceiptEmails(token);
    await R.stopReceiptEmails(token);
    const page = await R.resolveReceipt(token);
    expect(page.state === "ok" && page.emailStopped).toBe(true);
    expect((await R.saleReceiptState(saleId, policy({ email: "full" }))).onFile.emailStopped).toBe(true);
    await expect(R.sendReceiptFromStaff(saleId, { channel: "email", onFile: true }, staffActor())).rejects.toThrow(/turned off receipt emails/);
    await m.checkout.refundSale({ saleId, items: [], tipCents: 100, refundCardFee: false, reason: "Tip", restock: false, actor });
    expect((await deliveries(saleId)).at(-1)).toMatchObject({ purpose: "refund", skipped: "opted_out" });
    const audits = await m.db.db.select().from(s().auditLog).where(m.drizzle.and(eq(s().auditLog.action, "receipt.email_opt_out"), eq(s().auditLog.entityId, saleId)));
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain(customer.email!);
  });

  it("clients can ask for copies by the number on file: the same answer either way, and only so often", async () => {
    const { saleId, customer } = await paidTicket();
    const unknown = await R.requestReceiptCopies("(712) 555-0000");
    expect(unknown).toEqual({ channel: "sms", masked: "***-***-0000" });
    expect(await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.to, "+17125550000"))).toHaveLength(0);
    await expect(R.requestReceiptCopies("hello")).rejects.toThrow(/mobile number or email/);

    const r = await R.requestReceiptCopies(customer.phone!.slice(2));
    expect(r.masked).toBe(`***-***-${customer.phone!.slice(-4)}`);
    const rows = (await deliveries(saleId)).filter((d) => d.purpose === "request");
    expect(rows).toHaveLength(1);
    const text = await job(rows[0].jobId);
    expect(text).toMatchObject({ to: customer.phone, channel: "sms" });
    expect((await R.resolveReceipt(tokenIn(text.body))).state).toBe("ok");

    await R.requestReceiptCopies(customer.phone!);
    await R.requestReceiptCopies(customer.phone!);
    await R.requestReceiptCopies(customer.phone!);
    const jobs = await m.db.db.select().from(s().notificationJobs).where(m.drizzle.and(eq(s().notificationJobs.to, customer.phone!), eq(s().notificationJobs.kind, "receipt")));
    expect(jobs).toHaveLength(3);

    const byEmail = await R.requestReceiptCopies(customer.email!.toUpperCase());
    expect(byEmail.channel).toBe("email");
    const mail = (await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.to, customer.email!)))[0];
    expect(mail.subject).toMatch(/Your receipts/);
  });

  it("records the counter's choice once; after that it's a resend", async () => {
    const { saleId } = await paidTicket({ smsOptIn: true });
    await R.sendReceiptFromStaff(saleId, { channel: "sms", onFile: true, atCheckout: true }, staffActor());
    await R.sendReceiptFromStaff(saleId, { channel: "sms", onFile: true, atCheckout: true }, staffActor());
    expect((await deliveries(saleId)).map((d) => d.purpose)).toEqual(["counter", "resend"]);
    const latest = await R.latestReceipts([saleId]);
    expect(latest.get(saleId)).toMatchObject({ channel: "sms" });
    const audits = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.entityId, saleId));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["receipt.sent", "receipt.resent"]));
  });
});
