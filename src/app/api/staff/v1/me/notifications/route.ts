import { OPTIONS as options, getNotificationPrefs, putNotificationPrefs } from "@/server/staff-api/handlers";

export const GET = getNotificationPrefs;
export const PUT = putNotificationPrefs;
export const OPTIONS = options;
