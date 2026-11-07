import { json, options, query, route } from "@/server/api";
import { ReceiptListQuery } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { myReceipts } from "@/server/my-receipts";

export const OPTIONS = options;
export const GET = route(async (req) => {
  const q = query(req, ReceiptListQuery);
  return json(await myReceipts(await requireCustomer(req), { before: q.before ? new Date(q.before) : undefined, limit: q.limit }));
});
