import { z } from "zod";
import { body, json, options, route } from "@/server/api";
import { assertInternalSecret, createConnectOnboardingLink } from "@/server/payments/connect";

export const OPTIONS = options;
export const POST = route(async (req) => {
  assertInternalSecret(req);
  const b = await body(req, z.object({ shop: z.string().min(1) }));
  return json(await createConnectOnboardingLink(b.shop));
});
