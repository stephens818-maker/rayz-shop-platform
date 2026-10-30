import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { suggestedRebooks } from "@/server/suggested-rebook";

export const OPTIONS = options;
export const GET = route(async (req) => json(await suggestedRebooks(await requireCustomer(req))));
