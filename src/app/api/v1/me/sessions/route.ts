import { json, options, route } from "@/server/api";
import { endSessions, listSessions, requireCustomer, sessionFromRequest } from "@/server/auth/customer";

export const OPTIONS = options;
export const GET = route(async (req) => json({ sessions: await listSessions(await requireCustomer(req), await sessionFromRequest(req)) }));
export const DELETE = route(async (req) => json(await endSessions(await requireCustomer(req), { except: await sessionFromRequest(req) })));
