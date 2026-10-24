import "server-only";
import { json, options, route } from "./api";
import { requireCustomer } from "./auth/customer";
import { customerBadges } from "./customer-badges";

/** GET /me/badges: the signed-in customer's badges and progress. The web account page and the app share it. */
export const GET = route(async (req) => json(await customerBadges(await requireCustomer(req))));
export const OPTIONS = options;
