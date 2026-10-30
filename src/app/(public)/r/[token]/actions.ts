"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, staff } from "@/db/schema";
import { LINK_STATE_MESSAGE } from "@/domain/outreach";
import { formatDate, formatTime } from "@/lib/time";
import { safe } from "@/server/action";
import { audit, customerActor } from "@/server/audit";
import { cancelAppointment, rescheduleAppointment } from "@/server/booking";
import { shopBarbers } from "@/server/catalog";
import { AppError, notFound } from "@/server/errors";
import { markAnswered, resolveLink } from "@/server/rebook-links";

/** The link must still work; the token is the client's only credential here. */
async function open(token: string) {
  const r = await resolveLink(String(token ?? ""));
  if (r.state === "unknown") throw notFound("Link");
  if (r.state !== "ok") throw new AppError("conflict", LINK_STATE_MESSAGE[r.state]);
  const c = r.outreach.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, r.outreach.customerId), columns: { firstName: true } }) : null;
  return { ...r, actor: customerActor(c?.firstName ?? "client") };
}

const whenText = (d: Date) => `${formatDate(d)} at ${formatTime(d)}`;

/** A new time with any barber or the one they pick; their services and add-ons stay as booked. */
export async function rebookAction(token: string, startsAt: string, barber: string) {
  return safe(async () => {
    const r = await open(token);
    const at = new Date(startsAt);
    if (Number.isNaN(at.getTime()) || at <= new Date()) throw new AppError("bad_request", "Pick a time");
    let barberRef = "any";
    if (barber && barber !== "any") {
      const b = (await shopBarbers(r.appointment.shopId, { onlineOnly: true })).find((x) => x.slug === barber);
      if (!b) throw new AppError("bad_request", "Pick a barber");
      barberRef = b.id;
    }
    const moved = await rescheduleAppointment(r.appointment.code, { startsAt: at, barberRef, actor: r.actor, byCustomer: true, ignoreCutoff: true });
    await markAnswered(r.outreach.id, "rebooked", `Picked ${whenText(at)} with ${moved.barber.displayName} online`);
    await audit(r.actor, "callin.accepted", "appointment", r.appointment.id, { outreachId: r.outreach.id, via: "link", startsAt: at.toISOString() }, r.appointment.shopId);
    return { code: r.appointment.code };
  });
}

/** Moved to another barber at the same time, and happy with it. */
export async function keepAction(token: string) {
  return safe(async () => {
    const r = await open(token);
    if (!r.outreach.reassignedStaffId) throw new AppError("conflict", "Pick a new time below");
    const label = (await db.query.staff.findFirst({ where: eq(staff.id, r.appointment.staffId), columns: { displayLabel: true } }))?.displayLabel ?? "the new barber";
    await markAnswered(r.outreach.id, "rebooked", `Kept ${label} online`);
    await audit(r.actor, "callin.accepted", "appointment", r.appointment.id, { outreachId: r.outreach.id, via: "link", kept: true }, r.appointment.shopId);
    return { code: r.appointment.code };
  });
}

export async function declineAction(token: string) {
  return safe(async () => {
    const r = await open(token);
    await cancelAppointment(r.appointment.code, { actor: r.actor, byCustomer: true, ignoreCutoff: true, reason: "Declined from the call-in rebook link" });
    await markAnswered(r.outreach.id, "declined", "Cancelled from the link");
    await audit(r.actor, "callin.declined", "appointment", r.appointment.id, { outreachId: r.outreach.id, via: "link" }, r.appointment.shopId);
    return { code: r.appointment.code };
  });
}
