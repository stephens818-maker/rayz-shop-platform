import { json, options, route } from "@/server/api";
import { myOpenTickets } from "@/server/app-pay";
import { requireCustomer } from "@/server/auth/customer";

export const OPTIONS = options;
export const GET = route(async (req) => json({ tickets: await myOpenTickets(await requireCustomer(req)) }));
