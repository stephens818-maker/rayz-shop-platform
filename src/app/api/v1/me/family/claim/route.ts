import { body, json, options, route } from "@/server/api";
import { ClaimChildBody } from "@/server/api-schemas";
import { assertSwitch } from "@/server/app-switches";
import { requireCustomer } from "@/server/auth/customer";
import { claimChild } from "@/server/profile-security";

export const OPTIONS = options;
export const POST = route(async (req) => {
  await assertSwitch("family");
  const id = await requireCustomer(req);
  return json(await claimChild(id, await body(req, ClaimChildBody)));
});
