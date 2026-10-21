import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx, Tx } from "@/db";
import {
  EmailAttachment,
  auditLog,
  brandSettings,
  notificationJobs,
  poReceiptLines,
  poReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  shopProducts,
  shops,
  staff,
  vendorProducts,
  vendors,
} from "@/db/schema";
import { PoStatus, SuggestedOrder, needsApproval, planReceipt, poActionProblem, poNumber, poTotalCents, suggestOrders, weightedCostCents } from "@/domain/inventory";
import { PoDocument, poCsv, poPdf } from "@/domain/po-document";
import { formatCents } from "@/lib/money";
import { formatDate, isValidLocalDate, localDateOf, todayLocal } from "@/lib/time";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { enqueueShopEmail } from "../notifications/queue";
import { Who, assertOwnRecord, assertShop, lockStock, postMovements } from "./ledger";
import { stockLevels } from "./stock";

const uuids = (xs: string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

// ───────────────────────────── Vendors ─────────────────────────────

const optText = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((s) => blank(s));

export const VendorInput = z.object({
  name: z.string().trim().min(1, "Enter the vendor's name").max(120),
  contactName: optText,
  email: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((s) => blank(s))
    .refine((s) => s === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), "That email doesn't look right"),
  phone: optText,
  address: optText,
  accountNumber: optText,
  paymentTerms: optText,
  leadTimeDays: z.number().int("Lead time is whole days").min(0).max(365),
  minimumOrderCents: z.number().int().min(0).max(100_000_000),
  sendCsv: z.boolean(),
  notes: z
    .string()
    .trim()
    .max(4000)
    .nullish()
    .transform((s) => blank(s)),
});
export type VendorInput = z.input<typeof VendorInput>;

export async function saveVendor(who: Who, id: string | null, raw: VendorInput) {
  const v = VendorInput.parse(raw);
  const clash = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(sql`lower(${vendors.name}) = lower(${v.name}) ${id ? sql`and ${vendors.id} <> ${id}` : sql``}`);
  if (clash.length) throw new AppError("conflict", `There's already a vendor called ${v.name}`);
  if (id) {
    const [row] = await db
      .update(vendors)
      .set({ ...v, updatedAt: new Date() })
      .where(eq(vendors.id, id))
      .returning();
    if (!row) throw notFound("Vendor");
    await audit(who.actor, "vendor.update", "vendor", id, v, null);
    return row;
  }
  const [row] = await db.insert(vendors).values(v).returning();
  await audit(who.actor, "vendor.create", "vendor", row.id, v, null);
  return row;
}

/** Vendors are never deleted (orders point at them); inactive ones drop out of suggestions and new orders. */
export async function setVendorActive(who: Who, id: string, active: boolean) {
  const [row] = await db.update(vendors).set({ active, updatedAt: new Date() }).where(eq(vendors.id, id)).returning();
  if (!row) throw notFound("Vendor");
  await audit(who.actor, active ? "vendor.activate" : "vendor.deactivate", "vendor", id, {}, null);
}

export const VendorProductInput = z.object({
  productId: z.uuid(),
  vendorSku: optText,
  casePack: z.number().int("Case pack is whole units").min(1, "Case pack is at least 1").max(10_000),
  costCents: z.number().int().min(0).max(10_000_000),
  preferred: z.boolean(),
});

export async function saveVendorProduct(who: Who, vendorId: string, raw: z.input<typeof VendorProductInput>) {
  const v = VendorProductInput.parse(raw);
  await db.transaction(async (tx) => {
    const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, vendorId));
    if (!vendor) throw notFound("Vendor");
    if (v.preferred) await tx.update(vendorProducts).set({ preferred: false }).where(and(eq(vendorProducts.productId, v.productId), sql`${vendorProducts.vendorId} <> ${vendorId}`));
    await tx
      .insert(vendorProducts)
      .values({ vendorId, ...v })
      .onConflictDoUpdate({ target: [vendorProducts.vendorId, vendorProducts.productId], set: { vendorSku: v.vendorSku, casePack: v.casePack, costCents: v.costCents, preferred: v.preferred } });
    await audit(who.actor, "vendor.product", "vendor", vendorId, v, null, tx);
  });
}

export async function removeVendorProduct(who: Who, vendorId: string, productId: string) {
  await db.delete(vendorProducts).where(and(eq(vendorProducts.vendorId, vendorId), eq(vendorProducts.productId, productId)));
  await audit(who.actor, "vendor.product_remove", "vendor", vendorId, { productId }, null);
}

export async function listVendors(shopIds: string[]) {
  return (await db.execute(sql`
    select v.id, v.name, v.contact_name "contactName", v.email, v.phone, v.payment_terms "paymentTerms", v.lead_time_days "leadTimeDays",
      v.minimum_order_cents "minimumOrderCents", v.active, coalesce(vp.n, 0)::int products, coalesce(o.open, 0)::int "openOrders", coalesce(o.spend, 0)::int "spend90d"
    from vendors v
    left join (select vendor_id, count(*) n from vendor_products group by 1) vp on vp.vendor_id = v.id
    left join (
      select po.vendor_id,
        count(*) filter (where po.status in ('approved', 'sent', 'partially_received')) open,
        sum(coalesce(r.cents, 0)) spend
      from purchase_orders po
      left join (
        select r.purchase_order_id, sum(rl.qty * rl.unit_cost_cents) cents
        from po_receipts r join po_receipt_lines rl on rl.receipt_id = r.id
        where r.received_at > now() - interval '90 days'
        group by 1
      ) r on r.purchase_order_id = po.id
      where po.shop_id in ${uuids(shopIds)}
      group by 1
    ) o on o.vendor_id = v.id
    order by v.active desc, v.name`)) as unknown as {
    id: string;
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    paymentTerms: string | null;
    leadTimeDays: number;
    minimumOrderCents: number;
    active: boolean;
    products: number;
    openOrders: number;
    spend90d: number;
  }[];
}

export async function loadVendor(id: string) {
  const [vendor] = await db.select().from(vendors).where(eq(vendors.id, id));
  if (!vendor) return null;
  const catalog = await db
    .select({ productId: products.id, sku: products.sku, brand: products.brand, name: products.name, active: products.active, vendorSku: vendorProducts.vendorSku, casePack: vendorProducts.casePack, costCents: vendorProducts.costCents, preferred: vendorProducts.preferred })
    .from(vendorProducts)
    .innerJoin(products, eq(products.id, vendorProducts.productId))
    .where(eq(vendorProducts.vendorId, id))
    .orderBy(asc(products.brand), asc(products.name));
  return { vendor, catalog };
}

// ───────────────────────────── Suggested orders ─────────────────────────────

export interface ShopSuggestion {
  shopId: string;
  shop: string;
  orders: SuggestedOrder[];
  noVendor: ReturnType<typeof suggestOrders>["noVendor"];
}

/**
 * What each shop should order, per vendor: products whose projected stock (available plus on order,
 * in transit and already on a draft order) is at or below the reorder point, up to par, in whole cases.
 */
export async function suggestionsFor(shopIds: string[], tx: DBorTx = db): Promise<ShopSuggestion[]> {
  if (!shopIds.length) return [];
  const [levels, offers, drafts, shopRows] = await Promise.all([
    stockLevels(shopIds, { tx }),
    tx
      .select({ productId: vendorProducts.productId, vendorId: vendors.id, vendorName: vendors.name, vendorSku: vendorProducts.vendorSku, casePack: vendorProducts.casePack, costCents: vendorProducts.costCents, preferred: vendorProducts.preferred, minimum: vendors.minimumOrderCents })
      .from(vendorProducts)
      .innerJoin(vendors, and(eq(vendors.id, vendorProducts.vendorId), eq(vendors.active, true))),
    tx.execute(sql`
      select po.shop_id, l.product_id, sum(l.qty_ordered)::int n
      from purchase_order_lines l join purchase_orders po on po.id = l.purchase_order_id
      where po.status = 'draft' and po.shop_id in ${uuids(shopIds)}
      group by 1, 2`) as unknown as Promise<{ shop_id: string; product_id: string; n: number }[]>,
    tx.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, shopIds)).orderBy(asc(shops.name)),
  ]);
  const minimums = Object.fromEntries(offers.map((o) => [o.vendorId, o.minimum]));
  const drafted = new Map(drafts.map((d) => [`${d.shop_id}|${d.product_id}`, d.n]));
  return shopRows.map((s) => {
    const items = levels
      .filter((r) => r.shopId === s.id && r.active)
      .map((r) => ({
        productId: r.productId,
        sku: r.sku,
        name: `${r.brand} ${r.name}`,
        position: { onHand: r.onHand, committed: r.committed, onOrder: r.onOrder + (drafted.get(`${s.id}|${r.productId}`) ?? 0), inTransit: r.inTransit },
        levels: r.levels,
        offers: offers.filter((o) => o.productId === r.productId),
      }));
    return { shopId: s.id, shop: s.name, ...suggestOrders(items, minimums) };
  });
}

// ───────────────────────────── Purchase orders ─────────────────────────────

type Po = typeof purchaseOrders.$inferSelect;

async function lockPo(tx: Tx, who: Who, id: string): Promise<Po> {
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for("update");
  if (!po) throw notFound("Purchase order");
  assertOwnRecord(who, [po.shopId], "Purchase order");
  return po;
}

async function threshold(tx: DBorTx = db) {
  const [b] = await tx.select({ t: brandSettings.poApprovalThresholdCents }).from(brandSettings).limit(1);
  return b?.t ?? null;
}

/**
 * Draft orders for each shop and vendor picked, filled with what's suggested for that vendor (or
 * empty). Orders created together share a batch, so a brand-level buyer can review them as one.
 */
export async function createPos(who: Who, input: { picks: { shopId: string; vendorId: string }[]; fill: "suggested" | "empty"; notes?: string | null }) {
  if (!input.picks.length) throw new AppError("bad_request", "Pick at least one shop and vendor");
  for (const p of input.picks) assertShop(who, p.shopId);
  const vendorIds = [...new Set(input.picks.map((p) => p.vendorId))];
  const vendorRows = await db.select().from(vendors).where(inArray(vendors.id, vendorIds));
  for (const id of vendorIds) {
    const v = vendorRows.find((x) => x.id === id);
    if (!v) throw notFound("Vendor");
    if (!v.active) throw new AppError("conflict", `${v.name} is inactive`);
  }
  const suggestions = input.fill === "suggested" ? await suggestionsFor([...new Set(input.picks.map((p) => p.shopId))]) : [];
  const batchId = input.picks.length > 1 ? randomUUID() : null;
  const created: { id: string; number: number; shopId: string; vendorId: string; lines: number }[] = [];
  const skipped: { shopId: string; vendorId: string }[] = [];
  await db.transaction(async (tx) => {
    for (const pick of input.picks) {
      const order = suggestions.find((s) => s.shopId === pick.shopId)?.orders.find((o) => o.vendorId === pick.vendorId);
      if (input.fill === "suggested" && !order) {
        skipped.push(pick);
        continue;
      }
      const [po] = await tx
        .insert(purchaseOrders)
        .values({ shopId: pick.shopId, vendorId: pick.vendorId, batchId, notes: blank(input.notes), createdBy: who.actor.staffId ?? null })
        .returning();
      const lines = order?.lines ?? [];
      if (lines.length) {
        await tx
          .insert(purchaseOrderLines)
          .values(lines.map((l) => ({ purchaseOrderId: po.id, productId: l.productId, vendorSku: l.vendorSku, casePack: l.casePack, qtyOrdered: l.qty, unitCostCents: l.unitCostCents })));
      }
      await audit(
        who.actor,
        "po.create",
        "purchase_order",
        po.id,
        { number: po.number, vendorId: pick.vendorId, batchId, fill: input.fill, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCostCents: l.unitCostCents })) },
        pick.shopId,
        tx,
      );
      created.push({ id: po.id, number: po.number, shopId: pick.shopId, vendorId: pick.vendorId, lines: lines.length });
    }
  });
  return { created, skipped, batchId };
}

export const PoLineInput = z.object({
  productId: z.uuid(),
  qtyOrdered: z.number().int("Order whole units").min(1, "Quantities are at least 1").max(100_000),
  unitCostCents: z.number().int().min(0).max(10_000_000),
  vendorSku: optText,
  casePack: z.number().int().min(1).max(10_000),
});

export const PoEditInput = z.object({
  expectedOn: z
    .string()
    .nullish()
    .transform((s) => blank(s))
    .refine((s) => s === null || isValidLocalDate(s), "Pick a valid date"),
  notes: z
    .string()
    .max(2000)
    .nullish()
    .transform((s) => blank(s)),
  lines: z.array(PoLineInput).max(500),
});

/** Edits a draft or approved order. Changing an approved order sends it back to draft, so it's approved again. */
export async function updatePo(who: Who, id: string, raw: z.input<typeof PoEditInput>) {
  const v = PoEditInput.parse(raw);
  const ids = v.lines.map((l) => l.productId);
  if (new Set(ids).size !== ids.length) throw new AppError("bad_request", "Each product goes on the order once");
  return db.transaction(async (tx) => {
    const po = await lockPo(tx, who, id);
    const problem = poActionProblem(po.status, "edit");
    if (problem) throw new AppError("conflict", problem);
    if (ids.length) {
      const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, ids));
      if (found.length !== ids.length) throw new AppError("bad_request", "One of those products no longer exists");
    }
    const before = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
    if (v.lines.length) await tx.insert(purchaseOrderLines).values(v.lines.map((l) => ({ purchaseOrderId: id, ...l })));
    const reopened = po.status === "approved";
    await tx
      .update(purchaseOrders)
      .set({ expectedOn: v.expectedOn, notes: v.notes, updatedAt: new Date(), ...(reopened ? { status: "draft" as const, approvedAt: null, approvedBy: null } : {}) })
      .where(eq(purchaseOrders.id, id));
    await audit(
      who.actor,
      "po.update",
      "purchase_order",
      id,
      {
        number: po.number,
        ...(reopened ? { reopened: "Edited after approval, back to draft" } : {}),
        totalBefore: poTotalCents(before),
        total: poTotalCents(v.lines),
        lines: v.lines.map((l) => ({ productId: l.productId, qty: l.qtyOrdered, unitCostCents: l.unitCostCents })),
      },
      po.shopId,
      tx,
    );
    return { reopened };
  });
}

export async function approvePo(who: Who, id: string) {
  await db.transaction(async (tx) => {
    const po = await lockPo(tx, who, id);
    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
    const problem = poActionProblem(po.status, "approve", { lines: lines.length, overLimit: false });
    if (problem) throw new AppError("conflict", problem);
    const now = new Date();
    await tx.update(purchaseOrders).set({ status: "approved", approvedAt: now, approvedBy: who.actor.staffId ?? null, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(who.actor, "po.approve", "purchase_order", id, { number: po.number, total: poTotalCents(lines) }, po.shopId, tx);
  });
}

export async function poDocument(id: string, tx: DBorTx = db): Promise<PoDocument> {
  const [row] = await tx
    .select({ po: purchaseOrders, shop: shops, vendor: vendors })
    .from(purchaseOrders)
    .innerJoin(shops, eq(shops.id, purchaseOrders.shopId))
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(eq(purchaseOrders.id, id));
  if (!row) throw notFound("Purchase order");
  const [brand] = await tx.select({ name: brandSettings.name }).from(brandSettings).limit(1);
  const lines = await tx
    .select({ vendorSku: purchaseOrderLines.vendorSku, sku: products.sku, brand: products.brand, name: products.name, casePack: purchaseOrderLines.casePack, qtyOrdered: purchaseOrderLines.qtyOrdered, unitCostCents: purchaseOrderLines.unitCostCents })
    .from(purchaseOrderLines)
    .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
    .where(eq(purchaseOrderLines.purchaseOrderId, id))
    .orderBy(asc(products.brand), asc(products.name));
  const { po, shop, vendor } = row;
  return {
    number: po.number,
    date: localDateOf(po.sentAt ?? new Date()),
    expectedOn: po.expectedOn,
    notes: po.notes,
    brand: brand?.name ?? "Ray'z Barber Shop",
    shop: { name: shop.name, address: shop.address, city: shop.city, state: shop.state, zip: shop.zip, phone: shop.phone, email: shop.email },
    vendor: {
      name: vendor.name,
      contactName: vendor.contactName,
      email: vendor.email,
      phone: vendor.phone,
      address: vendor.address,
      accountNumber: vendor.accountNumber,
      paymentTerms: vendor.paymentTerms,
      minimumOrderCents: vendor.minimumOrderCents,
    },
    lines: lines.map((l) => ({ vendorSku: l.vendorSku, sku: l.sku, name: `${l.brand} ${l.name}`, casePack: l.casePack, qtyOrdered: l.qtyOrdered, unitCostCents: l.unitCostCents })),
  };
}

export const poFileName = (number: number, ext: "pdf" | "csv") => `${poNumber(number)}.${ext}`;

export function poAttachments(doc: PoDocument, csv: boolean): EmailAttachment[] {
  const files: EmailAttachment[] = [{ filename: poFileName(doc.number, "pdf"), contentType: "application/pdf", content: Buffer.from(poPdf(doc)).toString("base64") }];
  if (csv) files.push({ filename: poFileName(doc.number, "csv"), contentType: "text/csv", content: Buffer.from(poCsv(doc), "utf8").toString("base64") });
  return files;
}

export const SendInput = z.object({
  /** email: queued to the vendor with the PDF (and CSV). manual: phoned in or entered on the vendor's site. */
  method: z.enum(["email", "manual"]),
  to: z
    .string()
    .trim()
    .nullish()
    .transform((s) => blank(s)),
  csv: z.boolean().optional(),
  message: z
    .string()
    .max(2000)
    .nullish()
    .transform((s) => blank(s)),
  /** For manual: how it was placed, e.g. "Phoned in to Dana". */
  reference: z
    .string()
    .max(200)
    .nullish()
    .transform((s) => blank(s)),
});

/**
 * Sends the order. A draft under the approval limit is approved as it's sent; above the limit it
 * must be approved first. Email goes through the notification queue (so the outbox shows exactly
 * what the vendor gets, even while sending is switched off).
 */
export async function sendPo(who: Who, id: string, raw: z.input<typeof SendInput>) {
  const v = SendInput.parse(raw);
  return db.transaction(async (tx) => {
    const po = await lockPo(tx, who, id);
    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
    const total = poTotalCents(lines);
    const limit = await threshold(tx);
    const problem = poActionProblem(po.status, "send", { lines: lines.length, overLimit: needsApproval(total, limit) });
    if (problem) throw new AppError("conflict", problem);
    const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, po.vendorId));
    if (!vendor.active) throw new AppError("conflict", `${vendor.name} is inactive`);
    const now = new Date();
    const autoApproved = po.status === "draft";
    let sentTo: string;
    let jobId: string | null = null;
    let attachments: EmailAttachment[] = [];
    if (v.method === "email") {
      const to = v.to ?? vendor.email;
      if (!to) throw new AppError("bad_request", `${vendor.name} has no email address. Add one to the vendor, or mark the order as placed another way.`);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new AppError("bad_request", "That email doesn't look right");
      await tx.update(purchaseOrders).set({ sentAt: now }).where(eq(purchaseOrders.id, id));
      const doc = await poDocument(id, tx);
      attachments = poAttachments(doc, v.csv ?? vendor.sendCsv);
      const [shop] = await tx.select().from(shops).where(eq(shops.id, po.shopId));
      const units = lines.reduce((a, l) => a + l.qtyOrdered, 0);
      const body = [
        `Hi ${vendor.contactName?.split(" ")[0] ?? vendor.name},`,
        "",
        `Please find attached purchase order ${poNumber(po.number)} from ${doc.brand} ${shop.name}${vendor.accountNumber ? ` (account ${vendor.accountNumber})` : ""}: ${lines.length} ${lines.length === 1 ? "item" : "items"}, ${units} units, ${formatCents(total)}.`,
        "",
        `Ship to: ${doc.brand} ${shop.name}, ${shop.address}, ${shop.city}, ${shop.state} ${shop.zip}`,
        ...(po.expectedOn ? [`Needed by: ${formatDate(po.expectedOn, "EEE, MMM d, yyyy")}`] : []),
        ...(v.message ? ["", v.message] : []),
        "",
        "Please reply to confirm the order and the ship date.",
        "",
        "Thank you,",
        who.name,
        `${doc.brand} ${shop.name}${shop.phone ? ` · ${shop.phone}` : ""}${shop.email ? ` · ${shop.email}` : ""}`,
      ].join("\n");
      jobId = await enqueueShopEmail({ kind: "purchase_order", to, subject: `Purchase order ${poNumber(po.number)} from ${doc.brand} ${shop.name}`, body, shopId: po.shopId, purchaseOrderId: id, attachments }, tx, now);
      sentTo = to;
    } else {
      sentTo = v.reference ?? "Placed outside the app";
    }
    await tx
      .update(purchaseOrders)
      .set({
        status: "sent",
        sentAt: now,
        sentBy: who.actor.staffId ?? null,
        sentTo,
        updatedAt: now,
        ...(autoApproved ? { approvedAt: now } : {}),
      })
      .where(eq(purchaseOrders.id, id));
    await audit(
      who.actor,
      "po.send",
      "purchase_order",
      id,
      { number: po.number, method: v.method, to: sentTo, total, ...(autoApproved ? { autoApproved: limit === null ? "No approval limit set" : `Under the ${formatCents(limit)} approval limit` } : {}), attachments: attachments.map((a) => a.filename), jobId },
      po.shopId,
      tx,
    );
    return { jobId, sentTo, attachments: attachments.map((a) => a.filename) };
  });
}

export const ReceiveInput = z.object({
  lines: z.array(z.object({ lineId: z.uuid(), qty: z.number().int("Receive whole units").min(0), unitCostCents: z.number().int().min(0).nullish() })),
  note: z
    .string()
    .max(1000)
    .nullish()
    .transform((s) => blank(s)),
  /** Save a changed cost as the vendor's new price for next time. */
  updateVendorCost: z.boolean().optional(),
});

/**
 * A delivery against a sent order: some or all of what's due, at the price actually charged. Stock
 * comes in through the ledger, the shelf cost moves to the weighted average, and the order becomes
 * partially received or received.
 */
export async function receivePo(who: Who, id: string, raw: z.input<typeof ReceiveInput>) {
  const v = ReceiveInput.parse(raw);
  return db.transaction(async (tx) => {
    const po = await lockPo(tx, who, id);
    const problem = poActionProblem(po.status, "receive");
    if (problem) throw new AppError("conflict", problem);
    const lines = await tx
      .select({ l: purchaseOrderLines, brand: products.brand, name: products.name, priceCents: products.priceCents })
      .from(purchaseOrderLines)
      .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .for("update", { of: purchaseOrderLines });
    let plan: ReturnType<typeof planReceipt>;
    try {
      plan = planReceipt(
        lines.map(({ l, brand, name }) => ({ id: l.id, productId: l.productId, name: `${brand} ${name}`, qtyOrdered: l.qtyOrdered, qtyReceived: l.qtyReceived, unitCostCents: l.unitCostCents })),
        v.lines,
      );
    } catch (e) {
      throw new AppError("bad_request", (e as Error).message);
    }
    // Something ordered that the shop didn't carry yet starts being carried when it arrives.
    const missing = plan.lines.map((p) => lines.find((x) => x.l.id === p.lineId)!);
    await tx
      .insert(shopProducts)
      .values(missing.map((x) => ({ shopId: po.shopId, productId: x.l.productId, costCents: x.l.unitCostCents, priceCents: x.priceCents })))
      .onConflictDoNothing();
    const locked = await lockStock(
      tx,
      plan.lines.map((p) => ({ shopId: po.shopId, productId: p.productId })),
    );
    const now = new Date();
    const [receipt] = await tx.insert(poReceipts).values({ purchaseOrderId: id, shopId: po.shopId, note: v.note, receivedBy: who.actor.staffId ?? null, receivedAt: now }).returning();
    await tx.insert(poReceiptLines).values(plan.lines.map((p) => ({ receiptId: receipt.id, lineId: p.lineId, productId: p.productId, qty: p.qty, unitCostCents: p.unitCostCents })));
    const costs: { productId: string; from: number; to: number }[] = [];
    for (const p of plan.lines) {
      await tx
        .update(purchaseOrderLines)
        .set({ qtyReceived: sql`${purchaseOrderLines.qtyReceived} + ${p.qty}` })
        .where(eq(purchaseOrderLines.id, p.lineId));
      const s = locked.get(`${po.shopId}|${p.productId}`)!;
      const next = weightedCostCents(s.stock, s.cost_cents, p.qty, p.unitCostCents);
      if (next !== s.cost_cents) {
        await tx
          .update(shopProducts)
          .set({ costCents: next })
          .where(and(eq(shopProducts.shopId, po.shopId), eq(shopProducts.productId, p.productId)));
        costs.push({ productId: p.productId, from: s.cost_cents, to: next });
      }
      if (v.updateVendorCost && p.unitCostCents !== p.orderedCostCents) {
        await tx
          .update(vendorProducts)
          .set({ costCents: p.unitCostCents })
          .where(and(eq(vendorProducts.vendorId, po.vendorId), eq(vendorProducts.productId, p.productId)));
      }
    }
    await postMovements(
      tx,
      plan.lines.map((p) => ({ shopId: po.shopId, productId: p.productId, delta: p.qty, kind: "receive" as const, unitCostCents: p.unitCostCents, purchaseOrderId: id, receiptId: receipt.id })),
      { actor: who.actor, at: now, audit: false },
    );
    await tx
      .update(purchaseOrders)
      .set({ status: plan.status, updatedAt: now, ...(plan.status === "received" ? { receivedAt: now } : {}) })
      .where(eq(purchaseOrders.id, id));
    await audit(
      who.actor,
      "po.receive",
      "purchase_order",
      id,
      {
        number: po.number,
        receiptId: receipt.id,
        status: plan.status,
        lines: plan.lines.map((p) => ({ productId: p.productId, qty: p.qty, unitCostCents: p.unitCostCents, ...(p.unitCostCents !== p.orderedCostCents ? { orderedCostCents: p.orderedCostCents } : {}) })),
        ...(costs.length ? { shelfCost: costs } : {}),
        ...(v.updateVendorCost ? { vendorCostUpdated: true } : {}),
        note: v.note,
      },
      po.shopId,
      tx,
    );
    return { receiptId: receipt.id, status: plan.status as PoStatus, units: plan.lines.reduce((a, p) => a + p.qty, 0) };
  });
}

export async function cancelPo(who: Who, id: string, reason: string) {
  const why = blank(reason);
  if (!why) throw new AppError("bad_request", "Say why the order is cancelled");
  await db.transaction(async (tx) => {
    const po = await lockPo(tx, who, id);
    const problem = poActionProblem(po.status, "cancel");
    if (problem) throw new AppError("conflict", problem);
    const now = new Date();
    await tx.update(purchaseOrders).set({ status: "cancelled", cancelledAt: now, cancelledBy: who.actor.staffId ?? null, cancelReason: why, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(who.actor, "po.cancel", "purchase_order", id, { number: po.number, from: po.status, reason: why }, po.shopId, tx);
  });
}

/** Stops waiting for the rest of a partly delivered order; what's missing no longer counts as on order. */
export async function closePoShort(who: Who, id: string, reason: string) {
  const why = blank(reason);
  if (!why) throw new AppError("bad_request", "Say why the rest isn't coming");
  await db.transaction(async (tx) => {
    const po = await lockPo(tx, who, id);
    const problem = poActionProblem(po.status, "close");
    if (problem) throw new AppError("conflict", problem);
    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
    const now = new Date();
    await tx.update(purchaseOrders).set({ status: "received", closedShort: true, cancelReason: why, receivedAt: now, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(
      who.actor,
      "po.close_short",
      "purchase_order",
      id,
      { number: po.number, reason: why, short: lines.filter((l) => l.qtyReceived < l.qtyOrdered).map((l) => ({ productId: l.productId, qty: l.qtyOrdered - l.qtyReceived })) },
      po.shopId,
      tx,
    );
  });
}

export async function listPos(shopIds: string[], o: { status?: PoStatus | "open"; vendorId?: string; batchId?: string; limit?: number } = {}) {
  const statusFilter = o.status === "open" ? sql`and po.status in ('draft', 'approved', 'sent', 'partially_received')` : o.status ? sql`and po.status = ${o.status}` : sql``;
  return (await db.execute(sql`
    select po.id, po.number, po.status, po.shop_id "shopId", sh.name shop, po.vendor_id "vendorId", v.name vendor, po.batch_id "batchId",
      po.created_at "createdAt", po.sent_at "sentAt", po.expected_on "expectedOn", po.received_at "receivedAt", po.closed_short "closedShort",
      coalesce(sum(l.qty_ordered * l.unit_cost_cents), 0)::int "totalCents", count(l.id)::int lines,
      coalesce(sum(l.qty_ordered), 0)::int units, coalesce(sum(l.qty_received), 0)::int received,
      st.display_label "createdBy"
    from purchase_orders po
    join shops sh on sh.id = po.shop_id
    join vendors v on v.id = po.vendor_id
    left join purchase_order_lines l on l.purchase_order_id = po.id
    left join staff st on st.id = po.created_by
    where po.shop_id in ${uuids(shopIds)} ${statusFilter}
      ${o.vendorId ? sql`and po.vendor_id = ${o.vendorId}` : sql``}
      ${o.batchId ? sql`and po.batch_id = ${o.batchId}` : sql``}
    group by po.id, sh.name, v.name, st.display_label
    order by case when po.status in ('draft', 'approved') then 0 when po.status in ('sent', 'partially_received') then 1 else 2 end, po.number desc
    limit ${o.limit ?? 200}`)) as unknown as {
    id: string;
    number: number;
    status: PoStatus;
    shopId: string;
    shop: string;
    vendorId: string;
    vendor: string;
    batchId: string | null;
    createdAt: string;
    sentAt: string | null;
    expectedOn: string | null;
    receivedAt: string | null;
    closedShort: boolean;
    totalCents: number;
    lines: number;
    units: number;
    received: number;
    createdBy: string | null;
  }[];
}

/** Everything the order page shows: the order, its lines against stock at the shop, deliveries, emails and history. */
export async function loadPo(id: string) {
  const [row] = await db
    .select({ po: purchaseOrders, shop: { id: shops.id, name: shops.name }, vendor: vendors })
    .from(purchaseOrders)
    .innerJoin(shops, eq(shops.id, purchaseOrders.shopId))
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(eq(purchaseOrders.id, id));
  if (!row) return null;
  const [lines, receipts, jobs, history, limit, offers, people] = await Promise.all([
    db
      .select({ l: purchaseOrderLines, sku: products.sku, brand: products.brand, name: products.name })
      .from(purchaseOrderLines)
      .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(products.brand), asc(products.name)),
    db
      .select({ r: poReceipts, rl: poReceiptLines, by: staff.displayLabel })
      .from(poReceipts)
      .innerJoin(poReceiptLines, eq(poReceiptLines.receiptId, poReceipts.id))
      .leftJoin(staff, eq(staff.id, poReceipts.receivedBy))
      .where(eq(poReceipts.purchaseOrderId, id))
      .orderBy(asc(poReceipts.receivedAt)),
    db
      .select({ id: notificationJobs.id, to: notificationJobs.to, subject: notificationJobs.subject, body: notificationJobs.body, status: notificationJobs.status, runAt: notificationJobs.runAt, attachments: notificationJobs.attachments })
      .from(notificationJobs)
      .where(eq(notificationJobs.purchaseOrderId, id))
      .orderBy(desc(notificationJobs.runAt)),
    db
      .select({ at: auditLog.at, who: auditLog.actorLabel, action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entity, "purchase_order"), eq(auditLog.entityId, id)))
      .orderBy(desc(auditLog.at)),
    threshold(),
    db
      .select({ productId: vendorProducts.productId, vendorSku: vendorProducts.vendorSku, casePack: vendorProducts.casePack, costCents: vendorProducts.costCents })
      .from(vendorProducts)
      .where(eq(vendorProducts.vendorId, row.po.vendorId)),
    db
      .select({ id: staff.id, label: staff.displayLabel })
      .from(staff)
      .where(inArray(staff.id, [row.po.createdBy, row.po.approvedBy, row.po.sentBy, row.po.cancelledBy].filter((x): x is string => !!x).concat("00000000-0000-0000-0000-000000000000"))),
  ]);
  const stock = await stockLevels([row.po.shopId], { productIds: lines.map((l) => l.l.productId) });
  const total = poTotalCents(lines.map((l) => l.l));
  const byReceipt = new Map<string, { id: string; at: Date; by: string | null; note: string | null; lines: (typeof poReceiptLines.$inferSelect)[] }>();
  for (const r of receipts) {
    const e = byReceipt.get(r.r.id) ?? { id: r.r.id, at: r.r.receivedAt, by: r.by, note: r.r.note, lines: [] };
    e.lines.push(r.rl);
    byReceipt.set(r.r.id, e);
  }
  const label = (sid: string | null) => people.find((p) => p.id === sid)?.label ?? null;
  return {
    ...row,
    people: { createdBy: label(row.po.createdBy), approvedBy: label(row.po.approvedBy), sentBy: label(row.po.sentBy), cancelledBy: label(row.po.cancelledBy) },
    lines: lines.map(({ l, sku, brand, name }) => ({ ...l, sku, brand, name, stock: stock.find((s) => s.productId === l.productId) ?? null })),
    receipts: [...byReceipt.values()],
    jobs: jobs.map((j) => ({ ...j, attachments: (j.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: Math.round((a.content.length * 3) / 4) })) })),
    history,
    offers,
    totalCents: total,
    thresholdCents: limit,
    overLimit: needsApproval(total, limit),
    today: todayLocal(),
  };
}
