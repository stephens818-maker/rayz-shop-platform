import { OPTIONS as options, getAppointments, postAppointment } from "@/server/staff-api/handlers";

export const GET = getAppointments;
export const POST = postAppointment;
export const OPTIONS = options;
