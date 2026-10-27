import "server-only";
import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, sales, shops, staff } from "@/db/schema";
import { clientName } from "@/domain/client-privacy";
import { LocalDate, addDays, endOfLocalDay, localDateOf, localMinutesOf, startOfLocalDay } from "@/lib/time";
import type { ClientPolicy } from "./client-privacy";

/** Which appointments the list shows: still to come, finished, called off, or all. */
export const LIST_STATUSES = {
  all: null,
  upcoming: ["booked", "confirmed", "checked_in", "in_service"],
  completed: ["completed"],
  missed: ["cancelled", "no_show"],
} as const;
export type ListStatus = keyof typeof LIST_STATUSES;
export const isListStatus = (s: string | undefined): s is ListStatus => !!s && s in LIST_STATUSES;

export interface ListedAppointment {
  id: string;
  code: string;
  date: LocalDate;
  startMin: number;
  endMin: number;
  status: string;
  source: string;
  barber: string;
  staffId: string;
  customerId: string | null;
  customerName: string;
  services: string[];
  saleId: string | null;
  groupId: string | null;
}

/**
 * One shop's appointments over `days` days from `from`, in start order: the calendar as a list.
 * Names follow Client data like the calendar (a masked last name is an initial).
 */
export async function loadAppointmentList(
  shopId: string,
  from: LocalDate,
  days: number,
  o: { staffId: string | null; status: ListStatus; privacy: Pick<ClientPolicy, "show"> },
): Promise<{ shop: string; rows: ListedAppointment[] }> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { name: true } });
  const statuses = LIST_STATUSES[o.status];
  const rows = await db
    .select({
      a: appointments,
      barber: staff.displayLabel,
      firstName: customers.firstName,
      lastName: customers.lastName,
      saleId: sales.id,
    })
    .from(appointments)
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(sales, and(eq(sales.appointmentId, appointments.id), ne(sales.status, "voided")))
    .where(
      and(
        eq(appointments.shopId, shopId),
        gte(appointments.startsAt, startOfLocalDay(from)),
        lt(appointments.startsAt, endOfLocalDay(addDays(from, days - 1))),
        o.staffId ? eq(appointments.staffId, o.staffId) : undefined,
        statuses ? inArray(appointments.status, [...statuses]) : undefined,
      ),
    )
    .orderBy(asc(appointments.startsAt), asc(staff.displayLabel))
    .limit(1000);
  const items = rows.length
    ? await db
        .select({ appointmentId: appointmentItems.appointmentId, name: appointmentItems.name })
        .from(appointmentItems)
        .where(inArray(appointmentItems.appointmentId, rows.map((r) => r.a.id)))
        .orderBy(asc(appointmentItems.kind))
    : [];
  return {
    shop: shop?.name ?? "",
    rows: rows.map((r) => ({
      id: r.a.id,
      code: r.a.code,
      date: localDateOf(r.a.startsAt),
      startMin: localMinutesOf(r.a.startsAt),
      endMin: localMinutesOf(r.a.endsAt),
      status: r.a.status,
      source: r.a.source,
      barber: r.barber,
      staffId: r.a.staffId,
      customerId: r.a.customerId,
      customerName: r.firstName
        ? clientName(r.firstName, o.privacy.show("last_name", r.lastName))
        : (r.a.notes?.replace(/^Walk-in: /, "") ?? "Walk-in"),
      services: items.filter((i) => i.appointmentId === r.a.id).map((i) => i.name),
      saleId: r.saleId,
      groupId: r.a.groupId,
    })),
  };
}
