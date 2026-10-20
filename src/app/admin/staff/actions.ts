"use server";

import bcrypt from "bcryptjs";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { shops, staff, staffSchedules, staffShops, timeBlocks } from "@/db/schema";
import { findScheduleConflicts } from "@/domain/availability";
import { staffPublicSlug } from "@/lib/ids";
import { WEEKDAYS, addDays, minutesToLabel, startOfLocalDay, zonedWallTime } from "@/lib/time";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, requireStaff } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";

const MGR = ["brand_admin", "shop_manager"] as const;

/** Managers may only touch barbers linked to their own shop. */
async function assertCanEdit(ctx: StaffContext, staffId: string) {
  if (ctx.isAdmin) return;
  const s = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!s) throw notFound("Staff member");
  if (s.role === "brand_admin") throw forbidden();
  const links = await db.select().from(staffShops).where(and(eq(staffShops.staffId, staffId), inArray(staffShops.shopId, ctx.shopIds)));
  if (!links.length && s.id !== ctx.staff.id) throw forbidden("That person isn't on your shop's team");
}

const ProfileSchema = z.object({
  id: z.string().uuid().nullable(),
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().optional().default(""),
  displayLabel: z.string().trim().min(1, "Display label is required").max(24),
  email: z.string().trim().email().or(z.literal("")).optional().default(""),
  phone: z.string().trim().optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: z.enum(["brand_admin", "shop_manager", "barber"]),
  managerShopId: z.string().uuid().nullable(),
  isBookable: z.boolean(),
  active: z.boolean(),
  squireName: z.string().trim().optional().default(""),
  shopIds: z.array(z.string().uuid()),
  password: z.string().optional().default(""),
});

export async function saveProfileAction(raw: z.input<typeof ProfileSchema>) {
  return safe(async () => {
    const ctx = await requireStaff([...MGR]);
    const p = ProfileSchema.parse(raw);
    if (!ctx.isAdmin) {
      if (p.role !== "barber" && p.id !== ctx.staff.id) throw forbidden("Only the brand admin can assign manager or admin roles");
      if (p.shopIds.some((s) => !ctx.shopIds.includes(s))) throw forbidden("You can only add people to your own shop");
      if (p.id) await assertCanEdit(ctx, p.id);
    }
    if (p.role === "shop_manager" && !p.managerShopId) throw new AppError("bad_request", "Pick the shop this manager runs");
    const dup = await db.query.staff.findFirst({
      where: and(sql`lower(${staff.displayLabel}) = lower(${p.displayLabel})`, eq(staff.active, true), p.id ? ne(staff.id, p.id) : undefined),
    });
    if (dup) throw new AppError("conflict", `"${p.displayLabel}" is already used by another active barber. Add an initial, e.g. "${p.firstName} ${p.lastName?.[0] ?? "X"}."`);
    const values = {
      firstName: p.firstName,
      lastName: p.lastName || null,
      displayLabel: p.displayLabel,
      email: p.email ? p.email.toLowerCase() : null,
      phone: p.phone || null,
      color: p.color,
      role: p.role,
      managerShopId: p.role === "shop_manager" ? p.managerShopId : null,
      isBookable: p.isBookable,
      active: p.active,
      squireName: p.squireName || null,
      ...(p.password ? { passwordHash: await bcrypt.hash(p.password, 10) } : {}),
    };
    const id = await db.transaction(async (tx) => {
      let id = p.id;
      if (id) {
        await tx.update(staff).set(values).where(eq(staff.id, id));
      } else {
        const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(substring(${staff.staffCode} from 3)::int), 0)::int` }).from(staff);
        const [row] = await tx
          .insert(staff)
          .values({ ...values, staffCode: `S-${String(n + 1).padStart(4, "0")}`, publicSlug: staffPublicSlug(p.firstName) })
          .returning({ id: staff.id });
        id = row.id;
      }
      const scope = ctx.isAdmin ? null : ctx.shopIds;
      const existing = await tx.select().from(staffShops).where(eq(staffShops.staffId, id));
      for (const e of existing) {
        if (scope && !scope.includes(e.shopId)) continue;
        if (!p.shopIds.includes(e.shopId)) {
          await tx.delete(staffShops).where(and(eq(staffShops.staffId, id), eq(staffShops.shopId, e.shopId)));
          await tx.delete(staffSchedules).where(and(eq(staffSchedules.staffId, id), eq(staffSchedules.shopId, e.shopId)));
        }
      }
      for (const s of p.shopIds) {
        if (!existing.some((e) => e.shopId === s)) await tx.insert(staffShops).values({ staffId: id, shopId: s, isPrimary: existing.length === 0 && s === p.shopIds[0] });
      }
      await audit(ctx.actor, p.id ? "staff.update" : "staff.create", "staff", id, { ...values, passwordHash: undefined, shopIds: p.shopIds }, null, tx);
      return id;
    });
    revalidatePath("/admin/staff");
    return { id };
  });
}

export async function saveScheduleAction(staffId: string, rows: { shopId: string; weekday: number; startMin: number; endMin: number }[]) {
  return safe(async () => {
    const ctx = await requireStaff([...MGR]);
    await assertCanEdit(ctx, staffId);
    for (const r of rows) {
      if (!ctx.isAdmin && !ctx.shopIds.includes(r.shopId)) throw forbidden("You can only set hours at your own shop");
      if (r.endMin <= r.startMin) throw new AppError("bad_request", `${WEEKDAYS[r.weekday]}: end time must be after start time`);
    }
    const links = await db.select().from(staffShops).where(eq(staffShops.staffId, staffId));
    if (rows.some((r) => !links.some((l) => l.shopId === r.shopId))) throw new AppError("bad_request", "Add the shop to this person's shops first");
    // Validate against hours they already have at shops this editor can't see.
    const editable = ctx.isAdmin ? links.map((l) => l.shopId) : ctx.shopIds;
    const others = await db.select().from(staffSchedules).where(eq(staffSchedules.staffId, staffId));
    const keep = others.filter((o) => !editable.includes(o.shopId));
    const all = [...keep, ...rows].map((r) => ({ ...r, staffId }));
    const conflicts = findScheduleConflicts(all);
    if (conflicts.length) {
      const names = await db.select({ id: shops.id, name: shops.name }).from(shops);
      const nm = (id: string) => names.find((n) => n.id === id)?.name ?? "another shop";
      const [a, b] = (() => {
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++)
            if (all[i].weekday === all[j].weekday && all[i].startMin < all[j].endMin && all[j].startMin < all[i].endMin) return [all[i], all[j]];
        return [all[0], all[0]];
      })();
      throw new AppError(
        "conflict",
        `${WEEKDAYS[a.weekday]}: ${nm(a.shopId)} ${minutesToLabel(a.startMin)}–${minutesToLabel(a.endMin)} overlaps ${nm(b.shopId)} ${minutesToLabel(b.startMin)}–${minutesToLabel(b.endMin)}. A barber can't be at two shops at once.`,
      );
    }
    await db.transaction(async (tx) => {
      await tx.delete(staffSchedules).where(and(eq(staffSchedules.staffId, staffId), inArray(staffSchedules.shopId, editable.length ? editable : ["00000000-0000-0000-0000-000000000000"])));
      if (rows.length) await tx.insert(staffSchedules).values(rows.map((r) => ({ ...r, staffId })));
      await audit(ctx.actor, "staff.schedule", "staff", staffId, { rows }, null, tx);
    });
    revalidatePath(`/admin/staff/${staffId}`);
    revalidatePath("/admin/calendar");
    return null;
  });
}

export async function addTimeOffAction(input: { staffId: string; shopId: string | null; from: string; to: string; allDay: boolean; startMin: number; endMin: number; reason: string }) {
  return safe(async () => {
    const ctx = await requireStaff([...MGR]);
    await assertCanEdit(ctx, input.staffId);
    if (!input.reason.trim()) throw new AppError("bad_request", "A reason is required");
    if (input.shopId && !ctx.shopIds.includes(input.shopId)) throw forbidden();
    if (input.to < input.from) throw new AppError("bad_request", "End date is before start date");
    const startsAt = input.allDay ? startOfLocalDay(input.from) : zonedWallTime(input.from, input.startMin).toJSDate();
    const endsAt = input.allDay ? startOfLocalDay(addDays(input.to, 1)) : zonedWallTime(input.to, input.endMin).toJSDate();
    if (endsAt <= startsAt) throw new AppError("bad_request", "End must be after start");
    const [b] = await db
      .insert(timeBlocks)
      .values({ staffId: input.staffId, shopId: input.shopId, startsAt, endsAt, reason: input.reason.trim(), kind: input.allDay ? "day_off" : "block", createdBy: ctx.staff.id })
      .returning();
    await audit(ctx.actor, "block.create", "time_block", b.id, { staffId: input.staffId, reason: b.reason, kind: b.kind }, input.shopId);
    revalidatePath(`/admin/staff/${input.staffId}`);
    return null;
  });
}

export async function deleteTimeOffAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff([...MGR]);
    const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
    if (!b) throw notFound("Time off");
    await assertCanEdit(ctx, b.staffId);
    await db.delete(timeBlocks).where(eq(timeBlocks.id, id));
    await audit(ctx.actor, "block.delete", "time_block", id, { reason: b.reason }, b.shopId);
    revalidatePath(`/admin/staff/${b.staffId}`);
    return null;
  });
}
