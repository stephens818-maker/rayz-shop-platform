import "server-only";
import { SQL, and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { staff, staffGroupMembers, staffGroups, staffShops } from "@/db/schema";
import { BarberError, BarberGroup, BarberRef, BarberSelection, resolveBarbers } from "@/domain/barbers";
import { audit } from "./audit";
import type { StaffContext } from "./auth/staff";
import { AppError, forbidden, notFound } from "./errors";
import { inShops } from "./tenant";

export async function listBarberGroups(): Promise<BarberGroup[]> {
  const [groups, members] = await Promise.all([
    db.select({ id: staffGroups.id, name: staffGroups.name }).from(staffGroups).orderBy(asc(sql`lower(${staffGroups.name})`)),
    db
      .select({ groupId: staffGroupMembers.groupId, staffId: staffGroupMembers.staffId })
      .from(staffGroupMembers)
      .innerJoin(staff, eq(staff.id, staffGroupMembers.staffId))
      .orderBy(asc(staff.displayLabel)),
  ]);
  return groups.map((g) => ({ ...g, staffIds: members.filter((m) => m.groupId === g.id).map((m) => m.staffId) }));
}

/** Bookable people who work at any of these shops, by display label. Former barbers are included so past reports can name them. */
export async function barbersAt(shopIds: readonly string[]): Promise<BarberRef[]> {
  if (!shopIds.length) return [];
  const rows = await db
    .select({ id: staff.id, name: staff.displayLabel, active: staff.active, shopId: staffShops.shopId })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(inArray(staffShops.shopId, [...shopIds]), eq(staff.isBookable, true)))
    .orderBy(asc(staff.displayLabel));
  const out = new Map<string, BarberRef>();
  for (const r of rows) {
    const b = out.get(r.id) ?? { id: r.id, name: r.name, active: r.active, shopIds: [] };
    b.shopIds.push(r.shopId);
    out.set(r.id, b);
  }
  return [...out.values()];
}

/**
 * Display labels to name whoever turns up on a ticket, a visit or a rating. Labels only, never
 * surnames. With shops given, only people who work there or turn up in those shops' records, so a
 * shop's reports can't list another shop's team.
 */
export async function staffLabels(shopIds?: readonly string[]): Promise<Record<string, string>> {
  let scoped: SQL | undefined;
  if (shopIds) {
    const there = (table: string) => sql`exists (select 1 from ${sql.identifier(table)} x where x.staff_id = ${staff.id} and ${inShops({ shopIds }, sql`x.shop_id`)})`;
    scoped = sql`(${sql.join(["staff_shops", "sales", "appointments", "client_ratings"].map(there), sql` or `)})`;
  }
  const rows = await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(scoped);
  return Object.fromEntries(rows.map((r) => [r.id, r.label]));
}

/** Groups the viewer can pick: those with at least one barber they can see, cut down to those barbers. */
export const visibleBarberGroups = (groups: BarberGroup[], visible: BarberRef[]) => {
  const ids = new Set(visible.map((b) => b.id));
  return groups.map((g) => ({ ...g, staffIds: g.staffIds.filter((id) => ids.has(id)) })).filter((g) => g.staffIds.length > 0);
};

export interface ReportBarbers {
  selection: BarberSelection;
  /** Barbers the viewer may pick: those at any of their shops. */
  visible: BarberRef[];
  groups: BarberGroup[];
}

/**
 * The barbers a report covers for this viewer. Anyone outside their shops is refused; a group is cut
 * down to the barbers they can see. With `selfOnly`, it's always their own numbers.
 */
export async function reportBarbers(ctx: Pick<StaffContext, "shopIds" | "staff">, raw: string | string[] | null | undefined, o: { selfOnly: boolean }): Promise<ReportBarbers> {
  const [visible, groups] = await Promise.all([barbersAt(ctx.shopIds), o.selfOnly ? Promise.resolve([]) : listBarberGroups()]);
  try {
    const selection = resolveBarbers(raw, { visible, groups, self: o.selfOnly ? ctx.staff.id : null });
    return { selection, visible: o.selfOnly ? visible.filter((b) => b.id === ctx.staff.id) : visible, groups: visibleBarberGroups(groups, visible) };
  } catch (e) {
    if (e instanceof BarberError) throw forbidden(e.message);
    throw e;
  }
}

export const BarberGroupInput = z.object({
  name: z.string().trim().min(1, "Name the group").max(60, "Keep the name under 60 characters"),
  staffIds: z.array(z.string().uuid()).min(2, "Pick at least two barbers"),
});

type Manager = Pick<StaffContext, "actor" | "brandWide" | "permissions">;

function assertManager(ctx: Manager) {
  if (!ctx.permissions.has("barber_groups.manage")) throw forbidden("You can't manage barber groups");
  if (!ctx.brandWide) throw forbidden("Barber groups can include barbers at any shop, so only people with access to all shops can edit them");
}

async function checkInput(raw: z.input<typeof BarberGroupInput>, exceptId: string | null) {
  const g = BarberGroupInput.parse(raw);
  const staffIds = [...new Set(g.staffIds)];
  if (staffIds.length < 2) throw new AppError("bad_request", "Pick at least two barbers");
  const found = await db.select({ id: staff.id }).from(staff).where(inArray(staff.id, staffIds));
  if (found.length !== staffIds.length) throw new AppError("bad_request", "One of those barbers doesn't exist");
  const clash = await db
    .select({ id: staffGroups.id })
    .from(staffGroups)
    .where(and(sql`lower(${staffGroups.name}) = lower(${g.name})`, exceptId ? ne(staffGroups.id, exceptId) : undefined));
  if (clash.length) throw new AppError("conflict", "There's already a barber group with that name");
  return { name: g.name, staffIds };
}

export async function createBarberGroup(ctx: Manager, raw: z.input<typeof BarberGroupInput>): Promise<string> {
  assertManager(ctx);
  const g = await checkInput(raw, null);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(staffGroups).values({ name: g.name, createdBy: ctx.actor.staffId ?? null }).returning({ id: staffGroups.id });
    await tx.insert(staffGroupMembers).values(g.staffIds.map((staffId) => ({ groupId: row.id, staffId })));
    await audit(ctx.actor, "barber_group.create", "barber_group", row.id, g, null, tx);
    return row.id;
  });
}

export async function updateBarberGroup(ctx: Manager, id: string, raw: z.input<typeof BarberGroupInput>): Promise<void> {
  assertManager(ctx);
  const before = (await listBarberGroups()).find((x) => x.id === id);
  if (!before) throw notFound("Barber group");
  const g = await checkInput(raw, id);
  await db.transaction(async (tx) => {
    await tx.update(staffGroups).set({ name: g.name, updatedAt: new Date() }).where(eq(staffGroups.id, id));
    await tx.delete(staffGroupMembers).where(eq(staffGroupMembers.groupId, id));
    await tx.insert(staffGroupMembers).values(g.staffIds.map((staffId) => ({ groupId: id, staffId })));
    await audit(ctx.actor, "barber_group.update", "barber_group", id, { before: { name: before.name, staffIds: before.staffIds }, after: g }, null, tx);
  });
}

export async function deleteBarberGroup(ctx: Manager, id: string): Promise<void> {
  assertManager(ctx);
  const before = (await listBarberGroups()).find((x) => x.id === id);
  if (!before) throw notFound("Barber group");
  await db.transaction(async (tx) => {
    await tx.delete(staffGroups).where(eq(staffGroups.id, id));
    await audit(ctx.actor, "barber_group.delete", "barber_group", id, { name: before.name, staffIds: before.staffIds }, null, tx);
  });
}
