import { json, options, route } from "@/server/api";
import { myTicket } from "@/server/app-pay";
import { requireCustomer } from "@/server/auth/customer";

export const OPTIONS = options;
export const GET = route<{ id: string }>(async (req, { id }) => json({ ticket: await myTicket(await requireCustomer(req), id) }));
