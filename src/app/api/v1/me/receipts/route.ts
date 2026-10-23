import { json, options, query, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { listReceipts } from "@/server/mobile/receipts";
import { z } from "zod";

export const OPTIONS = options;

const Page = z.object({
  limit: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
});

export const GET = route(async (req) => {
  const page = query(req, Page);
  return json(await listReceipts(await requireCustomer(req), { limit: page.limit, cursor: page.cursor ?? null }));
});
