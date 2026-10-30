import { GET as get, OPTIONS as options } from "@/server/customer-badges-api";

/** The customer account page's badges; the same handler the public API mounts at /api/v1/me/badges. */
export const GET = get;
export const OPTIONS = options;
