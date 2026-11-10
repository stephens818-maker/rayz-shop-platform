import { body, json, options, route } from "@/server/api";
import { IdentityCheck } from "@/server/api-schemas";
import { checkIdentity, requireCustomer } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => json(await checkIdentity(await requireCustomer(req), await body(req, IdentityCheck))));
