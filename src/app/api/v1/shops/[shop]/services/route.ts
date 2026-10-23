import { json, options, route } from "@/server/api";
import { readClient } from "@/server/mobile/client";
import { publicServices } from "@/server/public";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (req, { shop }) => json(await publicServices(shop, readClient(req).locale)));
