import { body, json, options, route } from "@/server/api";
import { SecureBody } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { setSecured } from "@/server/profile-security";

export const OPTIONS = options;
export const PUT = route(async (req) => {
  const id = await requireCustomer(req);
  const { secured } = await body(req, SecureBody);
  return json(await setSecured(id, secured));
});
