import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { myAppointments } from "@/server/public";

export const OPTIONS = options;
export const GET = route(async (req) => json(await myAppointments(await requireCustomer(req))));
