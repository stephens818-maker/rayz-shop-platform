import { json, options, route } from "@/server/api";
import { publicShops } from "@/server/public";

export const OPTIONS = options;
export const GET = route(async () => json({ shops: await publicShops() }));
