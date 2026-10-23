import { json, options, route } from "@/server/api";
import { readClient } from "@/server/mobile/client";
import { publicShops } from "@/server/public";

export const OPTIONS = options;
export const GET = route(async (req) => json({ shops: await publicShops(readClient(req).locale) }));
