import { body, json, options, route } from "@/server/api";
import { CreateAppointment } from "@/server/api-schemas";
import { customerActor } from "@/server/audit";
import { customerFromRequest } from "@/server/auth/customer";
import { createAppointment } from "@/server/booking";
import { AppError } from "@/server/errors";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const b = await body(req, CreateAppointment);
  const customerId = await customerFromRequest(req);
  if (!customerId && !b.customer) throw new AppError("bad_request", "customer is required when not signed in");
  const idem = req.headers.get("idempotency-key");
  const appointment = await createAppointment({
    shopRef: b.shopId,
    serviceId: b.serviceId,
    addonIds: b.addonIds ?? [],
    barberRef: b.barberId ?? "any",
    startsAt: b.startsAt,
    customerId,
    customer: customerId ? null : b.customer,
    source: req.headers.get("x-client") === "web" ? "online" : "api",
    notes: b.notes ?? null,
    idempotencyKey: idem ? `api:${idem.slice(0, 100)}` : null,
    actor: customerActor(customerId ?? b.customer?.firstName ?? "guest"),
  });
  return json({ appointment }, 201);
});
