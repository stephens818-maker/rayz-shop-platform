import { OPTIONS as options, getFamily } from "@/server/family-api";

/** The account page's family; the same handlers the public API mounts at /api/v1/me/family. */
export const GET = getFamily;
export const OPTIONS = options;
