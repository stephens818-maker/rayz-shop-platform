import "server-only";
import { CustomerBadgesSchema } from "@/domain/customer-badges";
import { json, options, route } from "./api";
import { requireCustomer } from "./auth/customer";
import { customerBadges } from "./customer-badges";

/** GET /me/badges: the signed-in customer's badges and progress. The web account page and the app share it. */
export const GET = route(async (req) => json(await customerBadges(await requireCustomer(req))));
export const OPTIONS = options;

/** For openApiDocument: the path and its schema, in that file's shapes. */
export const CUSTOMER_BADGES_OPENAPI = {
  components: { CustomerBadges: CustomerBadgesSchema },
  paths: {
    "/me/badges": {
      get: {
        tags: ["Me"],
        summary: "My badges (only the ones the brand shows customers), when each was earned, and progress toward the next",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/CustomerBadges" } } } },
          401: { description: "Sign in required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
} as const;
