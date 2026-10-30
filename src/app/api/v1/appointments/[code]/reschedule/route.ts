import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { body, json, options, route } from "@/server/api";
import { assertShopSwitch, assertSwitch } from "@/server/app-switches";
import { RescheduleBody } from "@/server/api-schemas";
import { customerActor } from "@/server/audit";
import { customerFromRequest } from "@/server/auth/customer";
import { rescheduleAppointment } from "@/server/booking";

export const OPTIONS = options;
export const POST = route<{ code: string }>(async (req, { code }) => {
  const at = await db.query.appointments.findFirst({ where: eq(appointments.code, code), columns: { shopId: true } });
  if (at) await assertShopSwitch("booking", at.shopId);
  else await assertSwitch("booking");
  const b = await body(req, RescheduleBody);
  const customerId = await customerFromRequest(req);
  const appointment = await rescheduleAppointment(code, {
    startsAt: b.startsAt,
    barberRef: b.barberId === undefined ? undefined : (b.barberId ?? "any"),
    actor: customerActor(customerId ?? "link"),
    byCustomer: true,
    customerId,
  });
  return json({ appointment });
});
