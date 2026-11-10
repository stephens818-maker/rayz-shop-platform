import { body, json, options, route } from "@/server/api";
import { ClaimChildBody } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { claimChild } from "@/server/profile-security";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  return json(await claimChild(id, await body(req, ClaimChildBody)));
});
