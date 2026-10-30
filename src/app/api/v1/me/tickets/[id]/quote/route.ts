import { body, json, options, route } from "@/server/api";
import { QuoteBody } from "@/server/api-schemas";
import { quoteTicket } from "@/server/app-pay";
import { requireCustomer } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route<{ id: string }>(async (req, { id }) => {
  const customerId = await requireCustomer(req);
  return json({ quote: await quoteTicket(customerId, id, await body(req, QuoteBody)) });
});
