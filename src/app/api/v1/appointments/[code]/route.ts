import { json, options, route } from "@/server/api";
import { customerFromRequest } from "@/server/auth/customer";
import { getAppointmentByCode } from "@/server/booking";
import { AppError, notFound } from "@/server/errors";

export const OPTIONS = options;

/**
 * The code alone works until the shop's cancellation cutoff. After that, the caller needs a token.
 * A token, when present, has to belong to the customer on the appointment.
 */
export const GET = route<{ code: string }>(async (req, { code }) => {
  const customerId = await customerFromRequest(req);
  const appointment = await getAppointmentByCode(code);
  if (customerId) {
    if (appointment.customer?.id !== customerId) throw notFound("Appointment");
  } else if (Date.now() >= new Date(appointment.cancelCutoffAt).getTime()) {
    throw new AppError("unauthorized", "Sign in to view this appointment.");
  }
  return json({ appointment });
});
