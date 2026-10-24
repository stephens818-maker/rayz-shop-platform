import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { loyaltyBalance } from "@/server/loyalty";

export const OPTIONS = options;
export const GET = route(async (req) => json(await loyaltyBalance(await requireCustomer(req))));
