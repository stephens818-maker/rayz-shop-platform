import { body, json, options, route } from "@/server/api";
import { PayBody } from "@/server/api-schemas";
import { payTicket } from "@/server/app-pay";
import { requireCustomer } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route<{ id: string }>(async (req, { id }) => {
  const customerId = await requireCustomer(req);
  return json(await payTicket(customerId, id, await body(req, PayBody)));
});
