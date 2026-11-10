import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { json, options, route } from "@/server/api";
import { assertShopSwitch, assertSwitch } from "@/server/app-switches";
import { customerActor } from "@/server/audit";
import { requireCustomer } from "@/server/auth/customer";
import { rebookAppointment } from "@/server/booking";

export const OPTIONS = options;
export const POST = route<{ code: string }>(async (req, { code }) => {
  const at = await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()), columns: { shopId: true } });
  if (at) await assertShopSwitch("booking", at.shopId);
  else await assertSwitch("booking");
  const customerId = await requireCustomer(req);
  const appointment = await rebookAppointment(code, { customerId, actor: customerActor(customerId) });
  return json({ appointment }, 201);
});
