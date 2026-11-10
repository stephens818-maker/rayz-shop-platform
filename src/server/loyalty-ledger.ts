import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { customers, loyaltyLedger, sales, shops } from "@/db/schema";
import { needsIdentityCheck } from "./auth/customer";
import { AppError, notFound } from "./errors";
import { loyaltyOwner } from "./loyalty";

const LABELS: Record<string, string> = {
  earn: "Earned on a visit",
  reverse: "Taken back: a refund or a voided ticket",
  reward_issued: "Reward earned",
  reward_redeemed: "Reward used",
  import: "Brought over from Squire",
  expire: "Expired",
  merge: "Combined from a duplicate profile",
  convert: "The program changed how it counts",
};

type Cursor = { t: string; id: string };
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (!Number.isNaN(Date.parse(c.t)) && /^[0-9a-f-]{36}$/i.test(c.id)) return c;
  } catch {}
  throw new AppError("bad_request", "That cursor isn't valid; start from the first page", { field: "cursor" });
}

/**
 * I7: the card's history, newest first: the owner's (for a child on a household card, the parent's).
 * Squire's balance arrives as one `import` entry, flagged, so a moved-over balance reads as such.
 * An imported profile not yet confirmed as theirs sees nothing, like its rewards on GET /me/loyalty.
 */
export async function loyaltyHistory(customerId: string, opts: { cursor?: string; limit?: number } = {}) {
  const me = await db.query.customers.findFirst({ where: eq(customers.id, customerId), columns: { id: true, identityVerifiedAt: true, source: true } });
  if (!me) throw notFound("Customer");
  if (await needsIdentityCheck(me)) return { entries: [], nextCursor: null, redemptionLocked: true };
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const after = opts.cursor ? decode(opts.cursor) : null;
  const at = after ? new Date(after.t) : null;
  const owner = await loyaltyOwner(customerId);
  const rows = await db
    .select({ l: loyaltyLedger, shopId: shops.id, shopSlug: shops.slug, shopName: shops.name, saleNumber: sales.number, saleImported: sales.isImported, forFirstName: customers.firstName })
    .from(loyaltyLedger)
    .leftJoin(sales, eq(sales.id, loyaltyLedger.saleId))
    .leftJoin(shops, eq(shops.id, sales.shopId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(eq(loyaltyLedger.customerId, owner), after && at ? or(lt(loyaltyLedger.createdAt, at), and(eq(loyaltyLedger.createdAt, at), lt(loyaltyLedger.id, after.id))) : undefined))
    .orderBy(desc(loyaltyLedger.createdAt), desc(loyaltyLedger.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page.map((r) => ({
      id: r.l.id,
      kind: r.l.kind,
      label: LABELS[r.l.kind] ?? "Adjusted",
      progressDelta: r.l.progressDeltaCents,
      unit: (r.l.unit === "visits" ? "visits" : "cents") as "cents" | "visits",
      rewardCents: r.l.rewardCents,
      imported: r.l.kind === "import",
      createdAt: r.l.createdAt.toISOString(),
      receiptId: r.l.saleId && r.saleImported === false ? r.l.saleId : null,
      receiptNumber: r.saleImported === false ? r.saleNumber : null,
      forFirstName: r.forFirstName ?? null,
      shop: r.shopId ? { id: r.shopId, slug: r.shopSlug!, name: r.shopName! } : null,
    })),
    nextCursor: rows.length > limit && last ? encode({ t: last.l.createdAt.toISOString(), id: last.l.id }) : null,
    redemptionLocked: false,
  };
}
