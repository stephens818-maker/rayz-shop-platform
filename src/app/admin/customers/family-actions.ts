"use server";

import { eq, inArray } from "drizzle-orm";
import { clientName, maskLastName } from "@/domain/client-privacy";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { appointments, customers } from "@/db/schema";
import { ageOn } from "@/domain/family";
import { todayLocal } from "@/lib/time";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import {
  StaffContext,
  assertShopAccess,
  authorize,
  can,
} from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { customerAccess } from "@/server/customers";
import { AppError, forbidden } from "@/server/errors";
import {
  addChild,
  attachChild,
  detachChild,
  householdIds,
  splitChild,
  updateChild,
} from "@/server/family";
import { bookFamily, reassignWithinHousehold } from "@/server/family-booking";
import { staffWallTime } from "@/server/booking";

/** What this person may enter on a child's profile: the same per-field rules as any client. */
async function allowances(ctx: StaffContext, adding: boolean) {
  const p = await clientPolicy(ctx);
  const ok = (f: "notes" | "birthday" | "photo" | "preferred_barber") =>
    adding ? p.canAdd(f) : p.canEdit(f);
  return {
    notes: ok("notes"),
    birthday: ok("birthday"),
    photo: ok("photo"),
    preferredBarber: ok("preferred_barber"),
  };
}

async function reach(ctx: StaffContext, customerId: string) {
  if (
    !(await customerAccess(
      { staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") },
      customerId,
    ))
  )
    throw new AppError("not_found", "Client not found");
}

const touch = (...ids: (string | null | undefined)[]) => {
  for (const id of ids) if (id) revalidatePath(`/admin/customers/${id}`);
};

/** Add a child to a client's account, at the desk, at booking or at check-in. */
export async function addChildAction(guardianId: string, input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "clients.family",
      "You can't add family members",
    );
    await reach(ctx, guardianId);
    const c = await addChild(guardianId, input, ctx.actor, {
      allow: await allowances(ctx, true),
    });
    touch(guardianId);
    return { id: c.id, firstName: c.firstName, age: ageOn(c, todayLocal()) };
  });
}

export async function updateChildAction(childId: string, input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "clients.family",
      "You can't edit family members",
    );
    await reach(ctx, childId);
    const c = await updateChild(childId, input, ctx.actor, {
      allow: await allowances(ctx, false),
    });
    touch(childId, c.guardianId);
    return null;
  });
}

/** Take a child off the account; their record and history stay. */
export async function detachChildAction(childId: string) {
  return safe(async () => {
    const ctx = await authorize(
      "clients.family",
      "You can't edit family members",
    );
    await reach(ctx, childId);
    const r = await detachChild(childId, ctx.actor);
    touch(childId, r.guardianId);
    return null;
  });
}

/** An existing client (a Squire kid record, a duplicate on the parent's phone) becomes a child on this account. */
export async function attachChildAction(guardianId: string, childId: string) {
  return safe(async () => {
    const ctx = await authorize(
      "clients.family",
      "You can't edit family members",
    );
    await reach(ctx, guardianId);
    await reach(ctx, childId);
    const r = await attachChild(guardianId, z.uuid().parse(childId), ctx.actor);
    touch(guardianId, childId);
    revalidatePath("/admin/customers/duplicates");
    return r;
  });
}

const Split = z.object({
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(200).optional(),
  smsOptIn: z.boolean().default(false),
  emailOptIn: z.boolean().default(false),
  confirmedAge: z.boolean().optional(),
});

/** A child old enough gets their own account, keeping their history. Their phone or email is entered here. */
export async function splitChildAction(
  childId: string,
  raw: z.input<typeof Split>,
) {
  return safe(async () => {
    const ctx = await authorize(
      "clients.family",
      "You can't edit family members",
    );
    await reach(ctx, childId);
    const p = Split.parse(raw);
    const policy = await clientPolicy(ctx);
    if (
      (p.phone && !policy.canAdd("phone")) ||
      (p.email && !policy.canAdd("email"))
    )
      throw forbidden("You can't add contact details for clients");
    const r = await splitChild(childId, p, ctx.actor);
    touch(childId, r.guardianId);
    return null;
  });
}

/** At check-in: the appointment is for another member of the same family (booked under the parent, the child came). */
export async function setAppointmentMemberAction(
  appointmentId: string,
  customerId: string,
) {
  return safe(async () => {
    const ctx = await authorize(
      "calendar.manage",
      "You can't change appointments",
    );
    const a = await db.query.appointments.findFirst({
      where: eq(appointments.id, z.uuid().parse(appointmentId)),
      columns: { shopId: true },
    });
    if (!a) throw new AppError("not_found", "Appointment not found");
    assertShopAccess(ctx, a.shopId);
    await reassignWithinHousehold(
      appointmentId,
      z.uuid().parse(customerId),
      ctx.actor,
    );
    revalidatePath("/admin/calendar");
    revalidatePath("/admin/walk-ins");
    return null;
  });
}

/** Who else is on this appointment client's family account, for the check-in switch. */
export async function householdMembersAction(appointmentId: string) {
  return safe(async () => {
    const ctx = await authorize(
      "calendar.manage",
      "You can't change appointments",
    );
    const a = await db.query.appointments.findFirst({
      where: eq(appointments.id, z.uuid().parse(appointmentId)),
      columns: { shopId: true, customerId: true },
    });
    if (!a?.customerId)
      throw new AppError("not_found", "Appointment not found");
    assertShopAccess(ctx, a.shopId);
    const ids = await householdIds(a.customerId);
    const rows = await db
      .select({
        id: customers.id,
        firstName: customers.firstName,
        lastName: customers.lastName,
        guardianId: customers.guardianId,
        birthday: customers.birthday,
        birthYear: customers.birthYear,
      })
      .from(customers)
      .where(inArray(customers.id, ids));
    const today = todayLocal();
    return ids.flatMap((id) => {
      const r = rows.find((x) => x.id === id);
      return r
        ? [
            {
              id,
              name: clientName(r.firstName, maskLastName(r.lastName)),
              child: !!r.guardianId,
              age: r.guardianId ? ageOn(r, today) : null,
              current: id === a.customerId,
            },
          ]
        : [];
    });
  });
}

const StaffFamilyBooking = z.object({
  shopId: z.uuid(),
  guardianId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMin: z
    .number()
    .int()
    .min(0)
    .max(36 * 60),
  people: z
    .array(
      z.object({
        customerId: z.uuid(),
        serviceId: z.uuid(),
        addonIds: z.array(z.uuid()).max(10).default([]),
        staffId: z.uuid().nullable(),
        timing: z.enum(["same_time", "after"]).default("after"),
      }),
    )
    .min(1)
    .max(13),
  squeezeIn: z.boolean().optional(),
});

/** The calendar booking several family members at once: the first at the slot clicked, the rest alongside or right after. */
export async function staffFamilyBookingAction(
  raw: z.input<typeof StaffFamilyBooking>,
) {
  return safe(async () => {
    const ctx = await authorize(
      "calendar.manage",
      "You can't book appointments",
    );
    const p = StaffFamilyBooking.parse(raw);
    assertShopAccess(ctx, p.shopId);
    if (p.squeezeIn && !can(ctx, "calendar.squeeze_in"))
      throw forbidden("You can't squeeze in bookings");
    await reach(ctx, p.guardianId);
    const startsAt = staffWallTime(p.date, p.startMin).toISOString();
    const made = await bookFamily(
      {
        shopId: p.shopId,
        people: p.people.map((x, i) => ({
          ...x,
          startsAt: i === 0 ? startsAt : undefined,
        })),
      },
      {
        guardianId: p.guardianId,
        source: "staff",
        actor: ctx.actor,
        squeezeIn: p.squeezeIn,
      },
    );
    await audit(
      ctx.actor,
      "calendar.family_booking",
      "customer",
      p.guardianId,
      { appointments: made.length },
      p.shopId,
    );
    revalidatePath("/admin/calendar");
    return { codes: made.map((a) => a.code) };
  });
}
