import { json, options, route } from "@/server/api";
import { publicShopDetail } from "@/server/public";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (_req, { shop }) => json(await publicShopDetail(shop)));
