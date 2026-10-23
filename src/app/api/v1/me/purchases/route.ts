import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { purchaseHistory } from "@/server/mobile/purchases";

export const OPTIONS = options;
export const GET = route(async (req) => {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "20");
  return json(await purchaseHistory(await requireCustomer(req), Number.isFinite(limit) ? limit : 20));
});
