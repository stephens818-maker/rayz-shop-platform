import { body, json, options, route } from "@/server/api";
import { EmailChangeVerify } from "@/server/api-schemas";
import { requireCustomer, verifyEmailChange } from "@/server/auth/customer";
import { publicMe } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, EmailChangeVerify);
  await verifyEmailChange(id, b.email, b.code);
  return json(await publicMe(id));
});
