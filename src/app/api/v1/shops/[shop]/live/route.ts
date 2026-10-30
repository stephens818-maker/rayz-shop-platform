import { json, options, route } from "@/server/api";
import { liveWait } from "@/server/booking";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (_req, { shop }) => json(await liveWait(shop)));
