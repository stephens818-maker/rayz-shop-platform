"use server";

import bcrypt from "bcryptjs";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { roles, shops, staff, staffAccessShops, staffSchedules, staffShops, timeBlocks } from "@/db/schema";
import { findScheduleConflicts } from "@/domain/availability";
import { assignableRoles, staffEditDenied } from "@/domain/permissions";
import { labelContainsSurname, staffPublicSlug } from "@/lib/ids";
import { WEEKDAYS, addDays, minutesToLabel, startOfLocalDay } from "@/lib/time";
import { staffWallTime } from "@/server/booking";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { accessState, loadStaffAccess, workShopIds } from "@/server/auth/access";
import { timeBlockChangeDenied } from "@/server/auth/policy";
import { StaffContext, authorize, caller, staffGrantor } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { addBlock, removeBlock } from "@/server/staff-time";

/** Profile edits: nobody edits a person who holds access they don't have. */
async function assertCanEditProfile(ctx: StaffContext, staffId: string) {
  const target = await loadStaffAccess(staffId);
  if (!target) throw notFound("Staff member");
  const denied = staffEditDenied(staffGrantor(ctx), { ...accessState(target), workShopIds: await workShopIds(staffId) });
  if (denied) throw forbidden(denied);
  return target;
}

/** Schedules and time off: people who work at one of your shops, or yourself. */
async function assertCanSchedule(ctx: StaffContext, staffId: string) {
  const s = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!s) throw notFound("Staff member");
  if (ctx.brandWide || s.id === ctx.staff.id) return;
  const target = await loadStaffAccess(staffId);
  if (target?.isOwner) throw forbidden("Only someone with access to every shop can change the Brand Owner's schedule");
  const links = await db.select().from(staffShops).where(and(eq(staffShops.staffId, staffId), inArray(staffShops.shopId, ctx.shopIds)));
  if (!links.length) throw forbidden("That person isn't on your shops' team");
}

const ProfileSchema = z.object({
  id: z.string().uuid().nullable(),
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().optional().default(""),
  displayLabel: z.string().trim().min(1, "Display label is required").max(24),
  email: z.string().trim().email().or(z.literal("")).optional().default(""),
  phone: z.string().trim().optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Only used when adding someone; later role changes go through Permissions. */
  roleId: z.string().uuid().nullable().optional().default(null),
  isBookable: z.boolean(),
  active: z.boolean(),
  squireName: z.string().trim().optional().default(""),
  shopIds: z.array(z.string().uuid()),
  password: z.string().optional().default(""),
});

export async function saveProfileAction(raw: z.input<typeof ProfileSchema>) {
  return safe(async () => {
    const ctx = await authorize("staff.manage");
    const p = ProfileSchema.parse(raw);
    const outside = p.shopIds.filter((s) => !ctx.shopIds.includes(s));
    let role: typeof roles.$inferSelect | null = null;
    let current: Awaited<ReturnType<typeof loadStaffAccess>> = null;
    if (p.id) {
      current = await assertCanEditProfile(ctx, p.id);
      if ((await db.query.staff.findFirst({ where: eq(staff.id, p.id), columns: { kind: true } }))?.kind === "shop") throw new AppError("bad_request", "Shop logins are managed under Setup → Shop logins");
      const existing = await workShopIds(p.id);
      if (outside.some((s) => !existing.includes(s))) throw forbidden("You can only add people to your own shops");
      if (p.id === ctx.staff.id && !p.active) throw new AppError("bad_request", "You can't deactivate yourself");
    } else {
      if (outside.length) throw forbidden("You can only add people to your own shops");
      if (!p.roleId) throw new AppError("bad_request", "Pick a role");
      const all = await db.select().from(roles);
      role = assignableRoles(staffGrantor(ctx), all).find((r) => r.id === p.roleId) ?? null;
      if (!role) throw forbidden("You can't give that role: it has permissions you don't have");
      if (role.defaultScope === "all" && !ctx.brandWide) throw forbidden("Only people with access to all shops can add someone with access to all shops");
      if (role.defaultScope !== "all" && !p.shopIds.length) throw new AppError("bad_request", "Pick at least one shop this person works at");
    }
    if (p.lastName && labelContainsSurname(p.displayLabel, p.lastName)) {
      throw new AppError("bad_request", `The display label is shown to customers, so it can't include the last name. Try "${p.firstName} ${p.lastName[0]}."`);
    }
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
        const r = role!;
        const scope = r.defaultScope === "all" ? "all" : r.defaultScope === "one" ? "one" : "selected";
        const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(substring(${staff.staffCode} from 3)::int), 0)::int` }).from(staff);
        const [row] = await tx
          .insert(staff)
          .values({ ...values, roleId: r.id, shopScope: scope, staffCode: `S-${String(n + 1).padStart(4, "0")}`, publicSlug: staffPublicSlug(p.firstName) })
          .returning({ id: staff.id });
        id = row.id;
        const accessShops = scope === "all" ? [] : scope === "one" ? p.shopIds.slice(0, 1) : p.shopIds;
        if (accessShops.length) await tx.insert(staffAccessShops).values(accessShops.map((shopId) => ({ staffId: row.id, shopId })));
      }
      const editable = ctx.brandWide ? null : ctx.shopIds;
      const existing = await tx.select().from(staffShops).where(eq(staffShops.staffId, id));
      const removed: string[] = [];
      for (const e of existing) {
        if (editable && !editable.includes(e.shopId)) continue;
        if (!p.shopIds.includes(e.shopId)) {
          removed.push(e.shopId);
          await tx.delete(staffShops).where(and(eq(staffShops.staffId, id), eq(staffShops.shopId, e.shopId)));
          await tx.delete(staffSchedules).where(and(eq(staffSchedules.staffId, id), eq(staffSchedules.shopId, e.shopId)));
        }
      }
      const added = p.shopIds.filter((s) => !existing.some((e) => e.shopId === s));
      for (const s of added) await tx.insert(staffShops).values({ staffId: id, shopId: s, isPrimary: existing.length === 0 && s === p.shopIds[0] });
      // People scoped to "selected shops" can see the shops they work at; keep that in step.
      if (current && current.scope === "selected") {
        if (added.length) await tx.insert(staffAccessShops).values(added.map((shopId) => ({ staffId: id!, shopId }))).onConflictDoNothing();
        const drop = removed.filter((s) => current!.shopIds.includes(s));
        const left = current.shopIds.filter((s) => !drop.includes(s)).length + added.length;
        if (drop.length && left > 0) await tx.delete(staffAccessShops).where(and(eq(staffAccessShops.staffId, id), inArray(staffAccessShops.shopId, drop)));
      }
      await audit(
        ctx.actor,
        p.id ? "staff.update" : "staff.create",
        "staff",
        id,
        { ...values, passwordHash: undefined, passwordChanged: p.password ? true : undefined, shopIds: p.shopIds, role: role ? role.name : undefined },
        null,
        tx,
      );
      return id;
    });
    revalidatePath("/admin/staff");
    revalidatePath("/admin/permissions");
    return { id };
  });
}

export async function saveScheduleAction(staffId: string, rows: { shopId: string; weekday: number; startMin: number; endMin: number }[]) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    await assertCanSchedule(ctx, staffId);
    for (const r of rows) {
      if (!ctx.brandWide && !ctx.shopIds.includes(r.shopId)) throw forbidden("You can only set hours at your own shops");
      if (r.endMin <= r.startMin) throw new AppError("bad_request", `${WEEKDAYS[r.weekday]}: end time must be after start time`);
    }
    const links = await db.select().from(staffShops).where(eq(staffShops.staffId, staffId));
    if (rows.some((r) => !links.some((l) => l.shopId === r.shopId))) throw new AppError("bad_request", "Add the shop to this person's shops first");
    // Validate against hours they already have at shops this editor can't see.
    const editable = ctx.brandWide ? links.map((l) => l.shopId) : ctx.shopIds;
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

/** Time off a manager enters directly (no request). Booked appointments in it need `confirm`, and stay booked. */
export async function addTimeOffAction(input: {
  staffId: string;
  shopId: string | null;
  from: string;
  to: string;
  allDay: boolean;
  startMin: number;
  endMin: number;
  reasonId: string;
  note?: string | null;
  confirm?: boolean;
}) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    await assertCanSchedule(ctx, input.staffId);
    const denied = timeBlockChangeDenied(caller(ctx), { staffId: input.staffId, shopId: input.shopId }, await workShopIds(input.staffId));
    if (denied) throw forbidden(denied);
    if (input.to < input.from) throw new AppError("bad_request", "End date is before start date");
    const startsAt = input.allDay ? startOfLocalDay(input.from) : staffWallTime(input.from, input.startMin);
    const endsAt = input.allDay ? startOfLocalDay(addDays(input.to, 1)) : staffWallTime(input.to, input.endMin);
    if (endsAt <= startsAt) throw new AppError("bad_request", "End must be after start");
    const r = await addBlock(
      { staffId: input.staffId, shopId: input.shopId, startsAt, endsAt, reasonId: input.reasonId, note: input.note, timeOff: true, kind: input.allDay ? "day_off" : "block" },
      { actor: ctx.actor, confirm: input.confirm, via: "staff_page", auditShopId: input.shopId },
    );
    if (r.done) {
      revalidatePath(`/admin/staff/${input.staffId}`);
      revalidatePath("/admin/time-off");
    }
    return { saved: r.done, conflicts: r.conflicts };
  });
}

export async function deleteTimeOffAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
    if (!b) throw notFound("Time off");
    await assertCanSchedule(ctx, b.staffId);
    const denied = timeBlockChangeDenied(caller(ctx), b, await workShopIds(b.staffId));
    if (denied) throw forbidden(denied);
    await removeBlock(id, ctx.actor, "staff_page", b.shopId);
    revalidatePath(`/admin/staff/${b.staffId}`);
    revalidatePath("/admin/time-off");
    return null;
  });
}