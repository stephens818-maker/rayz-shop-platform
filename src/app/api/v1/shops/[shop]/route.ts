import { json, options, route } from "@/server/api";
import { readClient } from "@/server/mobile/client";
import { publicShop } from "@/server/public";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (req, { shop }) => json(await publicShop(shop, readClient(req).locale)));
