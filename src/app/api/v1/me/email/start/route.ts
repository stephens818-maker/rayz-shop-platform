import { clientIp } from "@/lib/client-ip";
import { body, json, options, route } from "@/server/api";
import { EmailChangeStart } from "@/server/api-schemas";
import { requireCustomer, startEmailChange } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  const { email } = await body(req, EmailChangeStart);
  return json(await startEmailChange(id, email, clientIp(req.headers)));
});
