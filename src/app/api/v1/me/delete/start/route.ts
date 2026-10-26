import { json, options, route } from "@/server/api";
import { requireCustomer, startDeletionCode } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => json(await startDeletionCode(await requireCustomer(req))));
