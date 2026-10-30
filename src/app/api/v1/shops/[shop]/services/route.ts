import { json, options, route } from "@/server/api";
import { publicServices } from "@/server/public";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (_req, { shop }) => json(await publicServices(shop)));
