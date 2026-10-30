import { OPTIONS as options, listBookingGroups, postBookingGroup } from "@/server/family-api";

export const GET = listBookingGroups;
export const POST = postBookingGroup;
export const OPTIONS = options;
