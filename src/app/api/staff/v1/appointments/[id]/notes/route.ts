import { OPTIONS as options, getAppointmentNotes, postAppointmentNote } from "@/server/staff-api/handlers";

export const GET = getAppointmentNotes;
export const POST = postAppointmentNote;
export const OPTIONS = options;
