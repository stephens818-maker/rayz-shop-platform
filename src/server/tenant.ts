import { AnyColumn, SQL, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  appointments,
  callIns,
  cashDrawers,
  giftCards,
  marketingCampaigns,
  messageThreads,
  notificationJobs,
  promoCodes,
  purchaseOrders,
  sales,
  staff,
  staffAccessShops,
  staffShops,
  stockCounts,
  stockTransfers,
  tipPayoutBatches,
  tipPayouts,
  waitlistEntries,
} from "@/db/schema";
import { AppError, forbidden } from "./errors";

/**
 * The tenant boundary. Every shop is its own workspace in the one database: a signed-in staff
 * member reads and writes only the shops in their access, and records that belong to no shop
 * (brand-level) only with access to every shop. Pages, server actions, route handlers and jobs that
 * take a shop or a record ID check it here; list queries filter with `inShops`.
 */
export interface Tenant {
  shopIds: readonly string[];
  /** Access to every shop, which is also what brand-level records need. */
  brandWide: boolean;
}

/** How a shop outside the caller's workspace is named wherever a record has to mention one. */
export const OTHER_SHOP = "Another Ray'z shop";

export const hasShop = (t: Pick<Tenant, "shopIds">, shopId: string | null | undefined) => !!shopId && t.shopIds.includes(shopId);

/** For a shop the caller chose (a form field, a query string): refused outright when it isn't theirs. */
export function assertShop(t: Pick<Tenant, "shopIds">, shopId: string, message = "That shop is outside your access") {
  if (!hasShop(t, shopId)) throw forbidden(message);
}

export function assertShops(t: Pick<Tenant, "shopIds">, shopIds: readonly string[], message?: string) {
  for (const s of shopIds) assertShop(t, s, message);
}

/** `column in (the caller's shops)`; matches nothing when they have none. */
export function inShops(t: Pick<Tenant, "shopIds">, column: AnyColumn | SQL): SQL {
  return t.shopIds.length ? inArray(column as AnyColumn, [...t.shopIds]) : sql`false`;
}

/** The caller's shops among those asked for; all of theirs when none are named. */
export function narrowShops(t: Pick<Tenant, "shopIds">, requested?: readonly string[] | null): string[] {
  if (!requested?.length) return [...t.shopIds];
  assertShops(t, requested);
  return [...requested];
}

export type TenantRecord =
  | "appointment"
  | "sale"
  | "purchase_order"
  | "transfer"
  | "stock_count"
  | "waitlist_entry"
  | "cash_drawer"
  | "notification_job"
  | "gift_card"
  | "promo"
  | "staff"
  | "call_in"
  | "message_thread"
  | "tip_payout_batch"
  | "tip_payout"
  | "marketing_campaign";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shops a record belongs to: one for most, both ends for a transfer, every shop a person works
 * at or can access for staff. An empty list is a brand-level record; null means there's no such record.
 */
export async function recordShops(kind: TenantRecord, id: string, tx: DBorTx = db): Promise<string[] | null> {
  if (!UUID.test(id)) return null;
  const one = async (q: Promise<{ s: string | null }[]>) => {
    const rows = await q;
    return rows.length ? (rows[0].s ? [rows[0].s] : []) : null;
  };
  switch (kind) {
    case "appointment":
      return one(tx.select({ s: appointments.shopId }).from(appointments).where(eq(appointments.id, id)));
    case "sale":
      return one(tx.select({ s: sales.shopId }).from(sales).where(eq(sales.id, id)));
    case "purchase_order":
      return one(tx.select({ s: purchaseOrders.shopId }).from(purchaseOrders).where(eq(purchaseOrders.id, id)));
    case "stock_count":
      return one(tx.select({ s: stockCounts.shopId }).from(stockCounts).where(eq(stockCounts.id, id)));
    case "waitlist_entry":
      return one(tx.select({ s: waitlistEntries.shopId }).from(waitlistEntries).where(eq(waitlistEntries.id, id)));
    case "cash_drawer":
      return one(tx.select({ s: cashDrawers.shopId }).from(cashDrawers).where(eq(cashDrawers.id, id)));
    case "gift_card":
      return one(tx.select({ s: giftCards.issuedShopId }).from(giftCards).where(eq(giftCards.id, id)));
    case "promo": {
      const [p] = await tx.select({ shopId: promoCodes.shopId, shopIds: promoCodes.shopIds }).from(promoCodes).where(eq(promoCodes.id, id));
      if (!p) return null;
      return p.shopIds?.length ? p.shopIds : p.shopId ? [p.shopId] : [];
    }
    case "marketing_campaign": {
      // A blast goes to its locations (none: every location); automated campaigns are the brand's.
      const [c] = await tx.select({ shopIds: marketingCampaigns.shopIds }).from(marketingCampaigns).where(eq(marketingCampaigns.id, id));
      return c ? c.shopIds : null;
    }
    case "message_thread":
      return one(tx.select({ s: messageThreads.shopId }).from(messageThreads).where(eq(messageThreads.id, id)));
    case "tip_payout_batch":
      return one(tx.select({ s: tipPayoutBatches.shopId }).from(tipPayoutBatches).where(eq(tipPayoutBatches.id, id)));
    case "tip_payout":
      return one(tx.select({ s: tipPayouts.shopId }).from(tipPayouts).where(eq(tipPayouts.id, id)));
    case "call_in": {
      // One shop, or every shop the barber works at for a call-in at all of them.
      const [c] = await tx.select({ shopId: callIns.shopId, staffId: callIns.staffId }).from(callIns).where(eq(callIns.id, id));
      if (!c) return null;
      if (c.shopId) return [c.shopId];
      const works = await tx.select({ s: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, c.staffId));
      return works.map((w) => w.s);
    }
    case "notification_job":
      return one(
        tx
          .select({ s: sql<string | null>`coalesce(${notificationJobs.shopId}, ${appointments.shopId})` })
          .from(notificationJobs)
          .leftJoin(appointments, eq(appointments.id, notificationJobs.appointmentId))
          .where(eq(notificationJobs.id, id)),
      );
    case "transfer": {
      const [t] = await tx.select({ from: stockTransfers.fromShopId, to: stockTransfers.toShopId }).from(stockTransfers).where(eq(stockTransfers.id, id));
      return t ? [t.from, t.to] : null;
    }
    case "staff": {
      const [s] = await tx.select({ scope: staff.shopScope }).from(staff).where(eq(staff.id, id));
      if (!s) return null;
      if (s.scope === "all") return [];
      const works = await tx.select({ s: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, id));
      const access = await tx.select({ s: staffAccessShops.shopId }).from(staffAccessShops).where(eq(staffAccessShops.staffId, id));
      return [...new Set([...works, ...access].map((r) => r.s))];
    }
  }
}

/** Whether a record is inside the caller's workspace: at one of their shops, or brand-level and they're brand-wide. */
export async function inTenant(t: Tenant, kind: TenantRecord, id: string, tx: DBorTx = db): Promise<boolean> {
  const shops = await recordShops(kind, id, tx);
  if (!shops) return false;
  if (!shops.length) return t.brandWide;
  return shops.some((s) => t.shopIds.includes(s));
}

/**
 * For actions: a record outside the workspace is reported as not found, the same as one that
 * doesn't exist, so IDs from another shop reveal nothing.
 */
export async function requireInTenant(t: Tenant, kind: TenantRecord, id: string, tx: DBorTx = db) {
  if (!(await inTenant(t, kind, id, tx))) throw new AppError("not_found", "Not found");
}
