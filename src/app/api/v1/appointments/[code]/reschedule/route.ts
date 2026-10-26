import { body, json, options, route } from "@/server/api";
import { assertSwitch } from "@/server/app-switches";
import { RescheduleBody } from "@/server/api-schemas";
import { customerActor } from "@/server/audit";
import { customerFromRequest } from "@/server/auth/customer";
import { rescheduleAppointment } from "@/server/booking";

export const OPTIONS = options;
export const POST = route<{ code: string }>(async (req, { code }) => {
  await assertSwitch("booking");
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
