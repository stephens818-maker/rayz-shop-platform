import { json, options, route } from "@/server/api";
import { liveWait } from "@/server/mobile/live-wait";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (_req, { shop }) => json(await liveWait(shop)));
