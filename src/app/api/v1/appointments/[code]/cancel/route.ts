import { json, options, route } from "@/server/api";
import { CancelBody } from "@/server/api-schemas";
import { customerActor } from "@/server/audit";
import { customerFromRequest } from "@/server/auth/customer";
import { cancelAppointment } from "@/server/booking";

export const OPTIONS = options;
export const POST = route<{ code: string }>(async (req, { code }) => {
  const raw = await req.text();
  const b = CancelBody.parse(raw ? JSON.parse(raw) : {});
  const customerId = await customerFromRequest(req);
  const appointment = await cancelAppointment(code, {
    actor: customerActor(customerId ?? "link"),
    byCustomer: true,
    customerId,
    reason: b.reason,
  });
  return json({ appointment });
});
