import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { locationGroupShops, locationGroups, shops } from "@/db/schema";
import { LocationError, LocationGroup, LocationSelection, resolveLocations } from "@/domain/locations";
import { audit } from "./audit";
import type { StaffContext } from "./auth/staff";
import { AppError, forbidden, notFound } from "./errors";

export async function listLocationGroups(): Promise<LocationGroup[]> {
  const [groups, members] = await Promise.all([
    db.select({ id: locationGroups.id, name: locationGroups.name }).from(locationGroups).orderBy(asc(sql`lower(${locationGroups.name})`)),
    db.select().from(locationGroupShops),
  ]);
  return groups.map((g) => ({ ...g, shopIds: members.filter((m) => m.groupId === g.id).map((m) => m.shopId) }));
}

/** The shops a report covers for this viewer. Anything outside their access is refused, except that a group is cut down to their shops. */
export async function reportLocations(
  ctx: Pick<StaffContext, "shopIds" | "currentShopId">,
  raw: string | string[] | null | undefined,
): Promise<{ selection: LocationSelection; groups: LocationGroup[] }> {
  const groups = await listLocationGroups();
  try {
    return { selection: resolveLocations(raw, { accessShopIds: ctx.shopIds, currentShopId: ctx.currentShopId, groups }), groups };
  } catch (e) {
    if (e instanceof LocationError) throw forbidden(e.message);
    throw e;
  }
}

/** Groups the viewer can pick: those with at least one of their shops. */
export const visibleGroups = (groups: LocationGroup[], shopIds: readonly string[]) => groups.filter((g) => g.shopIds.some((id) => shopIds.includes(id)));

export const GroupInput = z.object({
  name: z.string().trim().min(1, "Name the group").max(60, "Keep the name under 60 characters"),
  shopIds: z.array(z.string().uuid()).min(2, "Pick at least two shops"),
});

type Manager = Pick<StaffContext, "actor" | "brandWide" | "permissions">;

function assertManager(ctx: Manager) {
  if (!ctx.permissions.has("locations.manage")) throw forbidden("You can't manage location groups");
  if (!ctx.brandWide) throw forbidden("Location groups cover shops across the brand, so only people with access to all shops can edit them");
}

async function checkInput(raw: z.input<typeof GroupInput>, exceptId: string | null) {
  const g = GroupInput.parse(raw);
  const shopIds = [...new Set(g.shopIds)];
  if (shopIds.length < 2) throw new AppError("bad_request", "Pick at least two shops");
  const found = await db.select({ id: shops.id }).from(shops).where(inArray(shops.id, shopIds));
  if (found.length !== shopIds.length) throw new AppError("bad_request", "One of those shops doesn't exist");
  const clash = await db
    .select({ id: locationGroups.id })
    .from(locationGroups)
    .where(and(sql`lower(${locationGroups.name}) = lower(${g.name})`, exceptId ? ne(locationGroups.id, exceptId) : undefined));
  if (clash.length) throw new AppError("conflict", "There's already a group with that name");
  return { name: g.name, shopIds };
}

export async function createLocationGroup(ctx: Manager, raw: z.input<typeof GroupInput>): Promise<string> {
  assertManager(ctx);
  const g = await checkInput(raw, null);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(locationGroups).values({ name: g.name, createdBy: ctx.actor.staffId ?? null }).returning({ id: locationGroups.id });
    await tx.insert(locationGroupShops).values(g.shopIds.map((shopId) => ({ groupId: row.id, shopId })));
    await audit(ctx.actor, "location_group.create", "location_group", row.id, g, null, tx);
    return row.id;
  });
}

export async function updateLocationGroup(ctx: Manager, id: string, raw: z.input<typeof GroupInput>): Promise<void> {
  assertManager(ctx);
  const before = (await listLocationGroups()).find((x) => x.id === id);
  if (!before) throw notFound("Location group");
  const g = await checkInput(raw, id);
  await db.transaction(async (tx) => {
    await tx.update(locationGroups).set({ name: g.name, updatedAt: new Date() }).where(eq(locationGroups.id, id));
    await tx.delete(locationGroupShops).where(eq(locationGroupShops.groupId, id));
    await tx.insert(locationGroupShops).values(g.shopIds.map((shopId) => ({ groupId: id, shopId })));
    await audit(ctx.actor, "location_group.update", "location_group", id, { before: { name: before.name, shopIds: before.shopIds }, after: g }, null, tx);
  });
}

export async function deleteLocationGroup(ctx: Manager, id: string): Promise<void> {
  assertManager(ctx);
  const before = (await listLocationGroups()).find((x) => x.id === id);
  if (!before) throw notFound("Location group");
  await db.transaction(async (tx) => {
    await tx.delete(locationGroups).where(eq(locationGroups.id, id));
    await audit(ctx.actor, "location_group.delete", "location_group", id, { name: before.name, shopIds: before.shopIds }, null, tx);
  });
}
