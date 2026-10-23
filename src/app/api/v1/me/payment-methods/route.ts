import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { listCards } from "@/server/mobile/cards";

export const OPTIONS = options;
export const GET = route(async (req) => json(await listCards(await requireCustomer(req))));
