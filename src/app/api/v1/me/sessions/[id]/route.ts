import { json, options, route } from "@/server/api";
import { endSessions, requireCustomer } from "@/server/auth/customer";

export const OPTIONS = options;
export const DELETE = route<{ id: string }>(async (req, { id }) => json(await endSessions(await requireCustomer(req), { id })));
