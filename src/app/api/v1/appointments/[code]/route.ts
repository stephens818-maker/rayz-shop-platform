import { json, options, route } from "@/server/api";
import { getAppointmentByCode } from "@/server/booking";

export const OPTIONS = options;
export const GET = route<{ code: string }>(async (_req, { code }) => json({ appointment: await getAppointmentByCode(code) }));
