import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, DBorTx, Tx } from "@/db";
import { progressLabel, progressShare } from "@/domain/loyalty";
import { appointments, contactOptOuts, customers, notificationJobs, payments, receiptDeliveries, receiptOptOuts, refunds, saleItems, sales, shops, staff } from "@/db/schema";
import { feeLabel } from "@/domain/checkout";
import { groupByPerson } from "@/domain/combined-checkout";
import { maskEmail, maskPhone } from "@/domain/client-privacy";
import { receiptBranding } from "@/domain/connect";
import { takesOnlineBookings } from "@/domain/location-lifecycle";
import { fullAddress, mapsUrl } from "@/domain/location-profile";
import {
  DEFAULT_RECEIPT_FOOTER,
  REQUEST_LIMIT,
  ReceiptPerson,
  ReceiptPurpose,
  ReceiptSendChannel,
  ReceiptUpdate,
  barberFirstName,
  receiptConsent,
  receiptEmail,
  receiptListEmail,
  receiptListSms,
  receiptSms,
  tenderLabel,
} from "@/domain/receipts";
import { TOKEN_SHAPE, hashToken, newRebookToken } from "@/domain/rebook-token";
import { reviewRequestEmail, reviewRequestSms } from "@/domain/reviews";
import { appBaseUrl } from "@/lib/deployment";
import { formatCents } from "@/lib/money";
import { formatPhone, normalizeEmail, normalizePhone } from "@/lib/phone";
import { formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { Actor, audit, customerActor } from "./audit";
import { ticketAppointmentIds } from "./family-ticket";
import { contactFor, householdsByContact } from "./household-contact";
import type { ClientPolicy } from "./client-privacy";
import { AppError, notFound } from "./errors";
import { loyaltyBalance } from "./loyalty";
import { pushDevices } from "./notifications/queue";
import { reviewTiming } from "./review-rules";

export const receiptUrl = (token: string) => `${appBaseUrl()}/receipt/${token}`;

/** Purposes that are a choice of where the client wants this ticket's receipts; updates follow the latest one. */
const CHOICES: ReceiptPurpose[] = ["counter", "handoff", "request", "resend", "standing"];
/** A counter checkout's receipt question is open this long after paying. */
const CHECKOUT_WINDOW_MS = 12 * 60 * 60 * 1000;

const maskOf = (channel: ReceiptSendChannel, to: string) => (channel === "sms" ? maskPhone(to) : maskEmail(to))!;

/** A number that replied STOP, or an email that turned receipt emails off. */
export async function isOptedOut(channel: ReceiptSendChannel, to: string, tx: DBorTx = db) {
  if (channel === "sms") return !!(await tx.query.contactOptOuts.findFirst({ where: and(eq(contactOptOuts.phone, to), eq(contactOptOuts.channel, "sms")), columns: { id: true } }));
  return !!(await tx.query.receiptOptOuts.findFirst({ where: eq(receiptOptOuts.email, to), columns: { email: true } }));
}

/** Where a typed number or email goes: E.164 or lowercased. */
export function destinationOf(channel: ReceiptSendChannel, raw: string | null | undefined): string {
  const to = channel === "sms" ? normalizePhone(raw) : normalizeEmail(raw);
  if (!to) throw new AppError("bad_request", channel === "sms" ? "Enter a 10-digit mobile number" : "Enter an email address like name@example.com");
  return to;
}

// ───────────────────────────── What the receipt shows ─────────────────────────────

/** Everything on the digital receipt, from the ticket as it is now. No full card data, no contact details. */
export async function receiptData(saleId: string, tx: DBorTx = db, now = new Date()) {
  const sale = await tx.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  const [shop, items, pays, refs, barber, customer] = await Promise.all([
    tx.query.shops.findFirst({ where: eq(shops.id, sale.shopId) }),
    tx.select().from(saleItems).where(eq(saleItems.saleId, saleId)).orderBy(asc(saleItems.kind), asc(saleItems.name)),
    tx.select().from(payments).where(eq(payments.saleId, saleId)).orderBy(asc(payments.createdAt)),
    tx.select().from(refunds).where(eq(refunds.saleId, saleId)).orderBy(asc(refunds.createdAt)),
    sale.staffId ? tx.query.staff.findFirst({ where: eq(staff.id, sale.staffId), columns: { firstName: true, displayLabel: true, publicSlug: true, active: true, isBookable: true } }) : null,
    sale.customerId ? tx.query.customers.findFirst({ where: eq(customers.id, sale.customerId), columns: { id: true, firstName: true } }) : null,
  ]);
  if (!shop) throw notFound("Shop");
  const brand = receiptBranding(shop.receipt);
  const loyalty = customer ? await loyaltyBalance(customer.id, now, tx) : null;
  const pricing = (sale.pricing ?? {}) as { disclosures?: string[]; discounts?: { label: string; cents: number }[]; cardFee?: { rate: number } };
  const service = items.find((i) => i.kind === "service" && i.refId);
  const rebook = takesOnlineBookings(shop, todayLocal(now))
    ? (() => {
        const q = new URLSearchParams();
        if (barber?.active && barber.isBookable) q.set("barber", barber.publicSlug);
        if (service?.refId) q.set("service", service.refId);
        const s = q.toString();
        return `/book/${shop.slug}${s ? `?${s}` : ""}`;
      })()
    : null;
  const review = brand.reviewUrl ? await reviewTiming(saleId, now, tx) : null;
  const refundedCents = refs.reduce((a, r) => a + r.amountCents, 0);
  const people = await receiptPeople(sale, items, tx);
  const payerIds = [...new Set(pays.map((p) => p.payerCustomerId).filter((x): x is string => !!x))];
  const payerNames = new Map(payerIds.length ? (await tx.select({ id: customers.id, first: customers.firstName }).from(customers).where(inArray(customers.id, payerIds))).map((c) => [c.id, c.first]) : []);
  const payerOf = (p: (typeof pays)[number]) => (p.payerCustomerId ? payerNames.get(p.payerCustomerId) : null) ?? p.payerLabel ?? null;
  const labelOf = (p: (typeof pays)[number]) => `${tenderLabel(p)}${payerOf(p) ? ` (${payerOf(p)})` : ""}`;
  const shopLine = (brand.showAddress && shop.address && fullAddress(shop)) || null;
  return {
    sale: { id: sale.id, number: sale.number, status: sale.status, paidAt: sale.paidAt, createdAt: sale.createdAt, voidedAt: sale.voidedAt, isImported: sale.isImported },
    shop: {
      name: shop.name,
      title: brand.headline ?? `Ray'z Barber Shop · ${shop.name}`,
      logoUrl: brand.showLogo ? shop.logoUrl : null,
      accentColor: shop.accentColor,
      address: shopLine,
      mapUrl: shopLine ? mapsUrl(shop) : null,
      directionsUrl: shopLine ? `${appBaseUrl()}/locations/${shop.slug}/directions` : null,
      phone: brand.showPhone && shop.phone ? shop.phone : null,
      footer: brand.footer ?? DEFAULT_RECEIPT_FOOTER,
    },
    firstName: customer?.firstName ?? null,
    barber: barberFirstName(barber),
    lines: items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, qty: i.qty, cents: i.grossCents, refundedQty: i.refundedQty })),
    /** A ticket for more than one person (or barber): the lines by person, then barber. Null on an ordinary ticket. */
    people,
    discounts: pricing.discounts ?? [],
    subtotalCents: items.reduce((a, i) => a + i.grossCents, 0),
    taxCents: sale.serviceTaxCents + sale.productTaxCents,
    tipCents: sale.tipCents,
    fee: sale.cardFeeCents > 0 ? { label: pricing.cardFee ? feeLabel(pricing.cardFee) : "Credit card surcharge", cents: sale.cardFeeCents } : null,
    totalCents: sale.totalCents,
    tenders: pays.map((p) => ({ label: labelOf(p), cents: p.amountCents })),
    refunds: refs.map((r) => {
      const p = pays.find((x) => x.id === r.paymentId);
      const to = p ? labelOf(p) : r.method.replace("_", " ");
      return { label: r.kind === "void" ? `Voided, back to ${to}` : `Refunded to ${to}`, cents: r.amountCents, at: r.createdAt };
    }),
    refundedCents,
    disclosures: pricing.disclosures ?? [],
    loyalty:
      loyalty && loyalty.enabled
        ? {
            progressCents: loyalty.progressCents,
            thresholdCents: loyalty.thresholdCents,
            share: progressShare(loyalty),
            progress: progressLabel(loyalty, formatCents),
            rewardCents: loyalty.rewardCents,
            availableCents: loyalty.availableCents,
            text: `Loyalty: ${progressLabel(loyalty, formatCents)} toward your next ${formatCents(loyalty.rewardCents)} reward${loyalty.availableCents > 0 ? `, and ${formatCents(loyalty.availableCents)} in rewards ready to use` : ""}.`,
          }
        : null,
    rebookUrl: rebook,
    /** Only from the client's Nth visit, and not for a while after they tapped this location's link on another ticket. */
    reviewUrl: review && !review.hold ? brand.reviewUrl : null,
  };
}
export type ReceiptData = Awaited<ReturnType<typeof receiptData>>;

/**
 * A combined ticket's lines by person (first names only), each with their barbers' first names.
 * Null when the ticket is one person with one barber, so ordinary receipts stay as they are.
 */
async function receiptPeople(sale: { id: string; appointmentId: string | null }, items: (typeof saleItems.$inferSelect)[], tx: DBorTx): Promise<ReceiptPerson[] | null> {
  const ids = [sale.appointmentId, ...(await ticketAppointmentIds(sale.id, tx)), ...items.map((i) => i.appointmentId)].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  const barberIds = [...new Set(items.map((i) => i.staffId).filter((x): x is string => !!x))];
  if (ids.length < 2 && barberIds.length < 2) return null;
  const [who, barbers] = await Promise.all([
    ids.length
      ? tx.select({ id: appointments.id, first: customers.firstName }).from(appointments).leftJoin(customers, eq(customers.id, appointments.customerId)).where(inArray(appointments.id, ids))
      : [],
    barberIds.length ? tx.query.staff.findMany({ where: inArray(staff.id, barberIds), columns: { id: true, firstName: true, displayLabel: true } }) : [],
  ]);
  const barberName = (id: string | null) => {
    const b = id ? barbers.find((x) => x.id === id) : null;
    return b ? barberFirstName(b) : null;
  };
  const groups = groupByPerson(
    items,
    ids.map((id) => ({ appointmentId: id, name: who.find((w) => w.id === id)?.first ?? "Guest" })),
    { leadAppointmentId: sale.appointmentId, otherLabel: "Retail and other" },
  );
  return groups.map((g) => ({
    name: g.name,
    barbers: [...new Set(g.barbers.map((b) => barberName(b.staffId)).filter((x): x is string => !!x))],
    cents: g.lines.reduce((a, l) => a + l.grossCents, 0),
    lines: g.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, cents: l.grossCents, refunded: l.refundedQty > 0, refundedQty: l.refundedQty, barber: barberName(l.staffId) })),
  }));
}

/** The text or email for one ticket. */
export async function composeReceipt(saleId: string, channel: ReceiptSendChannel, url: string, update: ReceiptUpdate = null, tx: DBorTx = db) {
  const d = await receiptData(saleId, tx);
  if (channel === "sms") return { subject: d.shop.title, body: receiptSms({ title: d.shop.title, number: d.sale.number, totalCents: d.totalCents, url, update }) };
  return receiptEmail({
    title: d.shop.title,
    number: d.sale.number,
    when: formatDateTime(d.sale.paidAt ?? d.sale.createdAt),
    barber: d.people ? null : d.barber,
    lines: d.lines.map((l) => ({ name: l.name, qty: l.qty, cents: l.cents, refunded: l.refundedQty > 0 })),
    people: d.people,
    discounts: d.discounts,
    taxCents: d.taxCents,
    tipCents: d.tipCents,
    fee: d.fee,
    totalCents: d.totalCents,
    tenders: d.tenders,
    refunds: d.refunds,
    loyalty: d.loyalty?.text ?? null,
    footer: d.shop.footer,
    url,
    update,
    address: d.shop.address,
    phone: d.shop.phone ? formatPhone(d.shop.phone) || d.shop.phone : null,
    mapUrl: d.shop.directionsUrl,
  });
}

/** The tracked "Leave a review" link: counts the click, then goes on to the location's Google review page. */
export const reviewLinkUrl = (token: string) => `${receiptUrl(token)}/review`;

/** The review follow-up: the same words and link for every client. The link is tracked; the receipt link is there too. */
export async function composeReviewRequest(saleId: string, channel: ReceiptSendChannel, token: string, tx: DBorTx = db) {
  const d = await receiptData(saleId, tx);
  if (channel === "sms") return { subject: d.shop.title, body: reviewRequestSms({ title: d.shop.title, firstName: d.firstName, url: reviewLinkUrl(token) }) };
  return reviewRequestEmail({ title: d.shop.title, firstName: d.firstName, url: reviewLinkUrl(token), receiptUrl: receiptUrl(token), footer: d.shop.footer });
}

// ───────────────────────────── Sending ─────────────────────────────

export interface DeliverInput {
  saleId: string;
  channel: ReceiptSendChannel | "app" | "none";
  /** E.164 or lowercased email; the account holder's customer ID for "app"; ignored for "none". */
  to?: string | null;
  purpose: ReceiptPurpose;
  sentBy?: string | null;
  /** Staff typed it in for the client (a resend), rather than picking what's on file. */
  typed?: boolean;
  update?: ReceiptUpdate;
  now?: Date;
}

export type DeliverResult = { status: "none" } | { status: "queued"; masked: string; deliveryId: string } | { status: "skipped"; masked: string; why: "opted_out" | "no_consent" };

/**
 * Records the receipt and queues the text or email with its own link. Opt-outs and consent are
 * checked here: a client's own choice goes through unless they've opted out; a refund or void update
 * that can't go is recorded as skipped; anything else that can't go is refused with the reason.
 */
export async function deliverReceipt(o: DeliverInput, tx: DBorTx = db): Promise<DeliverResult> {
  const now = o.now ?? new Date();
  const sale = await tx.query.sales.findFirst({ where: eq(sales.id, o.saleId), columns: { id: true, shopId: true, customerId: true, status: true } });
  if (!sale) throw notFound("Sale");
  if (sale.status === "open") throw new AppError("conflict", "This ticket isn't paid yet");
  if (o.channel === "none") {
    await tx.insert(receiptDeliveries).values({ saleId: sale.id, shopId: sale.shopId, customerId: sale.customerId, channel: "none", purpose: o.purpose, sentBy: o.sentBy ?? null, createdAt: now });
    return { status: "none" };
  }
  if (o.channel === "app") return deliverToApp(sale, o, now, tx);
  const channel = o.channel;
  const to = destinationOf(channel, o.to);
  const masked = maskOf(channel, to);
  const c = await contactFor(tx, sale.customerId);
  const onFile = channel === "sms" ? c?.phone === to : !!c?.email && c.email.toLowerCase() === to;
  const chosen = await tx.query.receiptDeliveries.findFirst({
    where: and(eq(receiptDeliveries.saleId, sale.id), eq(receiptDeliveries.destination, to), inArray(receiptDeliveries.purpose, CHOICES), isNull(receiptDeliveries.skipped)),
    columns: { id: true },
  });
  const consent = receiptConsent({
    channel,
    purpose: o.purpose,
    optedOut: await isOptedOut(channel, to, tx),
    optedIn: onFile && (channel === "sms" ? !!c?.smsOptIn : !!c?.emailOptIn),
    chosenForSale: !!chosen,
    typed: o.typed,
  });
  if (!consent.ok) {
    if (o.purpose === "refund" || o.purpose === "void" || o.purpose === "review") {
      await tx.insert(receiptDeliveries).values({ saleId: sale.id, shopId: sale.shopId, customerId: sale.customerId, channel, destination: to, masked, purpose: o.purpose, skipped: consent.code, sentBy: o.sentBy ?? null, createdAt: now });
      return { status: "skipped", masked, why: consent.code };
    }
    throw new AppError("conflict", consent.message, { reason: consent.code });
  }
  const token = newRebookToken();
  const m = o.purpose === "review" ? await composeReviewRequest(sale.id, channel, token, tx) : await composeReceipt(sale.id, channel, receiptUrl(token), o.update ?? null, tx);
  const [job] = await tx
    .insert(notificationJobs)
    .values({ kind: o.purpose === "review" ? "review_request" : "receipt", channel, to, shopId: sale.shopId, customerId: sale.customerId, subject: channel === "email" ? m.subject : null, body: m.body, runAt: now })
    .returning({ id: notificationJobs.id });
  const [row] = await tx
    .insert(receiptDeliveries)
    .values({ saleId: sale.id, shopId: sale.shopId, customerId: sale.customerId, channel, destination: to, masked, purpose: o.purpose, tokenHash: hashToken(token), jobId: job.id, sentBy: o.sentBy ?? null, createdAt: now })
    .returning({ id: receiptDeliveries.id });
  return { status: "queued", masked, deliveryId: row.id };
}

export const APP_MASK = "the Ray'z app";

/**
 * In the app: the receipt is on the client's receipts list (GET /me/receipts) and, when they turned
 * appointment notifications on, a push to the household's devices says so. A child's receipt goes to
 * the parent who holds the account.
 */
async function deliverToApp(sale: { id: string; shopId: string; customerId: string | null }, o: DeliverInput, now: Date, tx: DBorTx): Promise<DeliverResult> {
  const [holder] = sale.customerId
    ? await tx.select({ id: sql<string>`coalesce(${customers.guardianId}, ${customers.id})` }).from(customers).where(eq(customers.id, sale.customerId))
    : [];
  if (!holder || (o.to && o.to !== holder.id)) throw new AppError("conflict", "This ticket isn't on an app account");
  const d = await receiptData(sale.id, tx, now);
  const update = o.update ?? null;
  const body =
    update?.kind === "void"
      ? `Ticket #${d.sale.number} was voided and ${formatCents(d.totalCents)} goes back to you.`
      : update?.kind === "refund"
        ? `${formatCents(update.refundedCents)} was refunded on ticket #${d.sale.number}.`
        : `Your receipt: ${formatCents(d.totalCents)}, ticket #${d.sale.number}. Tap to see it.`;
  const devices = await pushDevices(sale.customerId, tx);
  const jobs = devices.length
    ? await tx
        .insert(notificationJobs)
        .values(devices.map((to) => ({ kind: "receipt", channel: "push", to, shopId: sale.shopId, customerId: sale.customerId, subject: d.shop.title, body, runAt: now })))
        .returning({ id: notificationJobs.id })
    : [];
  const [row] = await tx
    .insert(receiptDeliveries)
    .values({
      saleId: sale.id,
      shopId: sale.shopId,
      customerId: sale.customerId,
      channel: "app",
      destination: holder.id,
      masked: APP_MASK,
      purpose: o.purpose,
      tokenHash: hashToken(newRebookToken()),
      jobId: jobs[0]?.id ?? null,
      sentBy: o.sentBy ?? null,
      createdAt: now,
    })
    .returning({ id: receiptDeliveries.id });
  return { status: "queued", masked: APP_MASK, deliveryId: row.id };
}

/**
 * Right after paying, with nothing asked at the counter (C9): the receipt goes where the client
 * (or the parent who holds their account) said in the app, to a verified email or the app. It runs in
 * a savepoint and never fails the payment.
 */
export async function sendStandingReceipt(saleId: string, tx: Tx, now = new Date()): Promise<DeliverResult | null> {
  try {
    return await tx.transaction(async (sp) => {
      const [h] = await sp
        .select({ id: customers.id, choice: customers.receiptDelivery, email: customers.email, verified: customers.emailVerifiedAt, deleted: customers.deletedAt })
        .from(sales)
        .innerJoin(customers, sql`${customers.id} = (select coalesce(c.guardian_id, c.id) from customers c where c.id = ${sales.customerId})`)
        .where(eq(sales.id, saleId));
      if (!h?.choice || h.deleted) return null;
      if (h.choice === "app") return deliverReceipt({ saleId, channel: "app", to: h.id, purpose: "standing", now }, sp);
      if (!h.email || !h.verified) return null;
      return deliverReceipt({ saleId, channel: "email", to: h.email.toLowerCase(), purpose: "standing", now }, sp);
    });
  } catch (e) {
    console.error("receipt: standing receipt not sent", saleId, (e as Error).message);
    return null;
  }
}

/** The client's latest choice for this ticket, which refund and void updates follow. */
export async function currentChoice(saleId: string, tx: DBorTx = db) {
  return (
    (await tx.query.receiptDeliveries.findFirst({
      where: and(eq(receiptDeliveries.saleId, saleId), inArray(receiptDeliveries.purpose, CHOICES), isNull(receiptDeliveries.skipped)),
      orderBy: [desc(receiptDeliveries.createdAt), desc(receiptDeliveries.id)],
    })) ?? null
  );
}

/**
 * After a refund or void: the updated receipt goes where the client last chose, if they wanted one.
 * It runs in a savepoint inside the refund's transaction and never fails the refund, which may
 * already have gone back to the card.
 */
export async function sendUpdatedReceipt(saleId: string, update: Exclude<ReceiptUpdate, null>, tx: Tx, now = new Date()): Promise<DeliverResult | null> {
  try {
    return await tx.transaction(async (sp) => {
      const choice = await currentChoice(saleId, sp);
      if (!choice || choice.channel === "none" || !choice.destination) return null;
      return deliverReceipt({ saleId, channel: choice.channel, to: choice.destination, purpose: update.kind, update, now }, sp);
    });
  } catch (e) {
    console.error("receipt: updated receipt not sent", saleId, (e as Error).message);
    return null;
  }
}

export interface StaffReceiptInput {
  channel: ReceiptSendChannel | "none";
  /** Send to the number or email on file, which this person may not be allowed to see. */
  onFile: boolean;
  to?: string;
  /** Asked at checkout, with the client there; later it's a resend. */
  atCheckout?: boolean;
}

/** Is the counter's "how would you like your receipt?" still open for this ticket? */
export async function checkoutReceiptOpen(saleId: string, tx: DBorTx = db, now = new Date()) {
  const sale = await tx.query.sales.findFirst({ where: eq(sales.id, saleId), columns: { paidAt: true, status: true, isImported: true } });
  if (!sale?.paidAt || sale.isImported || sale.status === "open") return false;
  if (now.getTime() - sale.paidAt.getTime() > CHECKOUT_WINDOW_MS) return false;
  const asked = await tx.query.receiptDeliveries.findFirst({ where: and(eq(receiptDeliveries.saleId, saleId), inArray(receiptDeliveries.purpose, ["counter", "handoff", "standing"])), columns: { id: true } });
  return !asked;
}

/** Staff sending the receipt: the counter's choice right after paying, or again later from the ticket or the client's history. */
export async function sendReceiptFromStaff(saleId: string, input: StaffReceiptInput, actor: Actor, now = new Date()) {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  if (sale.isImported) throw new AppError("conflict", "This ticket was imported from Squire, so there's no digital receipt for it");
  const purpose: ReceiptPurpose = input.atCheckout && (await checkoutReceiptOpen(saleId, db, now)) ? "counter" : "resend";
  if (input.channel === "none") {
    if (purpose !== "counter") throw new AppError("bad_request", "Pick text or email");
    await deliverReceipt({ saleId, channel: "none", purpose, sentBy: actor.staffId, now });
    await audit(actor, "receipt.none", "sale", saleId, { purpose }, sale.shopId);
    return { status: "none" as const, masked: null };
  }
  let to: string;
  if (input.onFile) {
    const c = await contactFor(db, sale.customerId);
    const v = input.channel === "sms" ? c?.phone : c?.email?.toLowerCase();
    if (!v) throw new AppError("bad_request", input.channel === "sms" ? "There's no mobile number on file" : "There's no email on file");
    to = v;
  } else to = destinationOf(input.channel, input.to);
  const r = await db.transaction((tx) => deliverReceipt({ saleId, channel: input.channel, to, purpose, sentBy: actor.staffId, typed: !input.onFile, now }, tx));
  if (r.status !== "queued") throw new AppError("conflict", "The receipt couldn't be sent");
  await audit(actor, purpose === "counter" ? "receipt.sent" : "receipt.resent", "sale", saleId, { channel: input.channel, to: r.masked, onFile: input.onFile, purpose }, sale.shopId);
  return { status: "queued" as const, masked: r.masked };
}

/**
 * A client asking for copies of their receipts, by the number or email they gave the shop. The answer
 * is the same whether or not it matched, so this can't be used to find out who's a client; what's sent
 * goes only to that number or email, never more often than REQUEST_LIMIT.
 */
export async function requestReceiptCopies(contact: string, now = new Date()) {
  const raw = String(contact ?? "").trim();
  const channel: ReceiptSendChannel = raw.includes("@") ? "email" : "sms";
  const to = channel === "sms" ? normalizePhone(raw) : normalizeEmail(raw);
  if (!to) throw new AppError("bad_request", "Enter the mobile number or email you gave the shop");
  const sent = { channel, masked: maskOf(channel, to) };
  const { people, ids } = await householdsByContact(db, channel === "sms" ? eq(customers.phone, to) : sql`lower(${customers.email}) = ${to}`);
  if (!people.length || (await isOptedOut(channel, to))) return sent;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [{ n }] = await db
    .select({ n: sql<number>`count(distinct ${receiptDeliveries.jobId})::int` })
    .from(receiptDeliveries)
    .where(and(eq(receiptDeliveries.destination, to), eq(receiptDeliveries.purpose, "request"), gte(receiptDeliveries.createdAt, hourAgo)));
  if (n >= REQUEST_LIMIT.perHour) return sent;
  const since = new Date(now);
  since.setMonth(since.getMonth() - REQUEST_LIMIT.months);
  const recent = await db
    .select({ id: sales.id, shopId: sales.shopId, customerId: sales.customerId, number: sales.number, totalCents: sales.totalCents, paidAt: sales.paidAt })
    .from(sales)
    .where(
      and(
        inArray(sales.customerId, ids),
        ne(sales.status, "open"),
        eq(sales.isImported, false),
        isNotNull(sales.paidAt),
        gte(sales.paidAt, since),
      ),
    )
    .orderBy(desc(sales.paidAt))
    .limit(REQUEST_LIMIT.visits);
  if (!recent.length) return sent;
  await db.transaction(async (tx) => {
    const items = recent.map((s) => ({ s, token: newRebookToken() }));
    const shop = await tx.query.shops.findFirst({ where: eq(shops.id, recent[0].shopId) });
    const brand = receiptBranding(shop?.receipt);
    const title = brand.headline ?? `Ray'z Barber Shop · ${shop?.name ?? ""}`;
    const list = items.map(({ s, token }) => ({ date: formatDate(s.paidAt!, "MMM d"), number: s.number, totalCents: s.totalCents, url: receiptUrl(token) }));
    const m = channel === "sms" ? { subject: null, body: receiptListSms({ title, items: list }) } : receiptListEmail({ title, items: list, footer: brand.footer ?? DEFAULT_RECEIPT_FOOTER });
    const [job] = await tx
      .insert(notificationJobs)
      .values({ kind: "receipt", channel, to, shopId: recent[0].shopId, customerId: recent[0].customerId, subject: m.subject, body: m.body, runAt: now })
      .returning({ id: notificationJobs.id });
    await tx
      .insert(receiptDeliveries)
      .values(items.map(({ s, token }) => ({ saleId: s.id, shopId: s.shopId, customerId: s.customerId, channel, destination: to, masked: sent.masked, purpose: "request" as const, tokenHash: hashToken(token), jobId: job.id, createdAt: now })));
    const who = people.find((p) => p.id === recent[0].customerId) ?? people[0];
    await audit(customerActor(who.firstName), "receipt.requested", "customer", who.id, { channel, to: sent.masked, sales: recent.map((s) => s.id) }, recent[0].shopId, tx);
  });
  return sent;
}

// ───────────────────────────── The receipt page ─────────────────────────────

export type ResolvedReceipt = { state: "unknown" } | { state: "ok"; delivery: typeof receiptDeliveries.$inferSelect; data: ReceiptData; emailStopped: boolean };

/** What a receipt link opens. Unknown and malformed tokens look the same from outside. */
export async function resolveReceipt(token: string, now = new Date()): Promise<ResolvedReceipt> {
  if (!TOKEN_SHAPE.test(token)) return { state: "unknown" };
  const delivery = await db.query.receiptDeliveries.findFirst({ where: eq(receiptDeliveries.tokenHash, hashToken(token)) });
  if (!delivery) return { state: "unknown" };
  const data = await receiptData(delivery.saleId, db, now);
  const emailStopped = delivery.channel === "email" && !!delivery.destination && (await isOptedOut("email", delivery.destination));
  return { state: "ok", delivery, data, emailStopped };
}

/** "Stop receipt and review emails" on the page from an emailed link. Texts stop with STOP. */
export async function stopReceiptEmails(token: string) {
  const r = await resolveReceipt(token);
  if (r.state !== "ok") throw notFound("Receipt");
  if (r.delivery.channel !== "email" || !r.delivery.destination) throw new AppError("bad_request", "Reply STOP to the text to stop texts from the shop");
  await db.insert(receiptOptOuts).values({ email: r.delivery.destination }).onConflictDoNothing();
  await audit(customerActor(r.data.firstName ?? "client"), "receipt.email_opt_out", "sale", r.delivery.saleId, { to: r.delivery.masked }, r.delivery.shopId);
}

// ───────────────────────────── For staff ─────────────────────────────

/** A number or email as this person may see it: in full where Client data allows, otherwise masked (never hidden, so they can still send to it). */
export function onFileShown(policy: ClientPolicy, c: { phone: string | null; email: string | null } | null) {
  return {
    phone: c?.phone ? (policy.level("phone") === "full" ? formatPhone(c.phone) || c.phone : maskPhone(c.phone)) : null,
    email: c?.email ? (policy.level("email") === "full" ? c.email : maskEmail(c.email)) : null,
  };
}

/** What's on file to send receipts to, as this person may see it, and whether each has opted out. */
export async function receiptOnFile(policy: ClientPolicy, c: { phone: string | null; email: string | null } | null) {
  const [smsStopped, emailStopped] = await Promise.all([c?.phone ? isOptedOut("sms", c.phone) : false, c?.email ? isOptedOut("email", c.email.toLowerCase()) : false]);
  return { ...onFileShown(policy, c), smsStopped, emailStopped };
}

/** The receipt panel on a ticket: what's on file (as this person may see it), what's been sent, and whether checkout's question is open. */
export async function saleReceiptState(saleId: string, policy: ClientPolicy, now = new Date()) {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId), columns: { customerId: true, isImported: true } });
  if (!sale) throw notFound("Sale");
  const c = sale.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, sale.customerId), columns: { phone: true, email: true } }) : null;
  const [rows, open, onFile] = await Promise.all([
    db
      .select({ d: receiptDeliveries, status: notificationJobs.status, by: staff.displayLabel })
      .from(receiptDeliveries)
      .leftJoin(notificationJobs, eq(notificationJobs.id, receiptDeliveries.jobId))
      .leftJoin(staff, eq(staff.id, receiptDeliveries.sentBy))
      .where(eq(receiptDeliveries.saleId, saleId))
      .orderBy(desc(receiptDeliveries.createdAt)),
    checkoutReceiptOpen(saleId, db, now),
    receiptOnFile(policy, c ?? null),
  ]);
  return {
    available: !sale.isImported,
    atCheckout: open,
    onFile,
    history: rows.map((r) => ({
      id: r.d.id,
      at: r.d.createdAt.toISOString(),
      channel: r.d.channel,
      masked: r.d.masked,
      purpose: r.d.purpose,
      status: r.d.skipped ?? r.status ?? (r.d.channel === "none" ? "none" : "pending"),
      by: r.by,
    })),
  };
}
export type SaleReceiptState = Awaited<ReturnType<typeof saleReceiptState>>;

/** For the client's purchase history: each ticket's latest receipt. */
export async function latestReceipts(saleIds: string[]) {
  if (!saleIds.length) return new Map<string, { channel: string; masked: string | null; at: Date }>();
  const rows = await db
    .selectDistinctOn([receiptDeliveries.saleId], { saleId: receiptDeliveries.saleId, channel: receiptDeliveries.channel, masked: receiptDeliveries.masked, at: receiptDeliveries.createdAt })
    .from(receiptDeliveries)
    .where(and(inArray(receiptDeliveries.saleId, saleIds), isNull(receiptDeliveries.skipped), ne(receiptDeliveries.purpose, "review")))
    .orderBy(receiptDeliveries.saleId, desc(receiptDeliveries.createdAt));
  return new Map(rows.map((r) => [r.saleId, { channel: r.channel, masked: r.masked, at: r.at }]));
}
