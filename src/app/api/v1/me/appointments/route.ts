import { json, options, query, route } from "@/server/api";
import { AppointmentListQuery } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { assertSwitch } from "@/server/app-switches";
import { myAppointments } from "@/server/public";

export const OPTIONS = options;
export const GET = route(async (req) => {
  const id = await requireCustomer(req);
  const q = query(req, AppointmentListQuery);
  if (q.family) await assertSwitch("family");
  return json(await myAppointments(id, new Date(), q));
});
