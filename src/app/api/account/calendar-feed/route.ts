import { OPTIONS as options, deleteCalendarFeed, getCalendarFeed, postCalendarFeed } from "@/server/calendar-feed-api";

export const GET = getCalendarFeed;
export const POST = postCalendarFeed;
export const DELETE = deleteCalendarFeed;
export const OPTIONS = options;
