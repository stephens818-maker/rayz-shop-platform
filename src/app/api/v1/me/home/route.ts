import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { customerHome } from "@/server/mobile/home";

export const OPTIONS = options;
export const GET = route(async (req) => json(await customerHome(await requireCustomer(req))));
