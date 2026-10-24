import "server-only";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { savedClientSearches, shops, staff } from "@/db/schema";
import { compactSegment, encodeFilter } from "@/domain/client-filters";
import { SegmentSchema } from "@/domain/marketing";
import { audit } from "./audit";
import { can, type StaffContext } from "./auth/staff";
import { AppError, forbidden, notFound } from "./errors";

export const VISIBILITY_LABEL = { private: "Only me", shop: "This location", brand: "Everyone in the brand" } as const;
export type Visibility = keyof typeof VISIBILITY_LABEL;

export interface SavedSearch {
  id: string;
  name: string;
  visibility: Visibility;
  shop: string | null;
  owner: string;
  mine: boolean;
  /** May rename or delete it: its owner, or a brand-wide person with saved searches for shared ones. */
  mayDelete: boolean;
  term: string;
  /** The client list's `f` parameter. */
  f: string;
}

const mayManageShared = (ctx: StaffContext) => ctx.brandWide && can(ctx, "clients.saved_searches") && can(ctx, "clients.view_all");

/** Saved searches this person can use: their own, their locations', and the brand's. */
export async function listSavedSearches(ctx: StaffContext): Promise<SavedSearch[]> {
  const rows = await db
    .select({ s: savedClientSearches, shop: shops.name, owner: staff.displayLabel })
    .from(savedClientSearches)
    .innerJoin(staff, eq(staff.id, savedClientSearches.ownerId))
    .leftJoin(shops, eq(shops.id, savedClientSearches.shopId))
    .where(
      or(
        eq(savedClientSearches.ownerId, ctx.staff.id),
        eq(savedClientSearches.visibility, "brand"),
        and(eq(savedClientSearches.visibility, "shop"), ctx.brandWide ? undefined : ctx.shopIds.length ? inArray(savedClientSearches.shopId, [...ctx.shopIds]) : sql`false`),
      ),
    )
    .orderBy(desc(savedClientSearches.updatedAt))
    .limit(100);
  return rows.map(({ s, shop, owner }) => {
    const seg = SegmentSchema.safeParse(s.filter);
    const mine = s.ownerId === ctx.staff.id;
    return {
      id: s.id,
      name: s.name,
      visibility: s.visibility,
      shop,
      owner,
      mine,
      mayDelete: mine || (s.visibility !== "private" && mayManageShared(ctx)),
      term: s.term,
      f: seg.success ? encodeFilter(seg.data) : "",
    };
  });
}

const SaveInput = z.object({
  id: z.uuid().nullable().default(null),
  name: z.string().trim().min(1, "Name it").max(80),
  visibility: z.enum(["private", "shop", "brand"]).default("private"),
  term: z.string().trim().max(120).default(""),
  segment: SegmentSchema,
});

/**
 * Save the client list's search and filters. Sharing with a location needs to work there; sharing
 * with the brand needs brand-wide access. The filters are checked again whenever someone opens it,
 * against what that person may see.
 */
export async function saveSearch(ctx: StaffContext, raw: unknown): Promise<string> {
  if (!can(ctx, "clients.saved_searches")) throw forbidden("Saving searches needs \"Save client searches and share them\"");
  const p = SaveInput.parse(raw);
  if (!p.term && !Object.keys(compactSegment(p.segment)).length) throw new AppError("bad_request", "Search or filter for something first");
  if (Object.keys(compactSegment(p.segment)).length && !can(ctx, "clients.filters")) throw forbidden("Filters need \"Use advanced client filters\"");
  const shopId = p.visibility === "shop" ? (ctx.currentShopId ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : null)) : null;
  if (p.visibility === "shop" && !shopId) throw new AppError("bad_request", "Pick a location in the header to share with it");
  if (p.visibility === "brand" && !ctx.brandWide) throw forbidden("Only brand-wide staff can share with the whole brand");
  const values = { name: p.name, visibility: p.visibility, shopId, term: p.term, filter: compactSegment(p.segment) as Record<string, unknown>, updatedAt: new Date() };
  let id = p.id;
  if (id) {
    const cur = await db.query.savedClientSearches.findFirst({ where: eq(savedClientSearches.id, id) });
    if (!cur) throw notFound("Saved search");
    if (cur.ownerId !== ctx.staff.id && !(cur.visibility !== "private" && mayManageShared(ctx))) throw forbidden("Only its owner can change this saved search");
    await db.update(savedClientSearches).set(values).where(eq(savedClientSearches.id, id));
  } else {
    id = (await db.insert(savedClientSearches).values({ ...values, ownerId: ctx.staff.id }).returning({ id: savedClientSearches.id }))[0].id;
  }
  await audit(ctx.actor, "client_search.save", "saved_client_search", id, { name: p.name, visibility: p.visibility }, ctx.currentShopId);
  return id;
}

export async function deleteSearch(ctx: StaffContext, id: string) {
  const cur = await db.query.savedClientSearches.findFirst({ where: eq(savedClientSearches.id, id) });
  if (!cur) throw notFound("Saved search");
  if (cur.ownerId !== ctx.staff.id && !(cur.visibility !== "private" && mayManageShared(ctx))) throw forbidden("Only its owner can delete this saved search");
  await db.delete(savedClientSearches).where(eq(savedClientSearches.id, id));
  await audit(ctx.actor, "client_search.delete", "saved_client_search", id, { name: cur.name }, ctx.currentShopId);
}
