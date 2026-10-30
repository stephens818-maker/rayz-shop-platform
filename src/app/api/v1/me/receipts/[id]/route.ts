import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { myReceipt } from "@/server/my-receipts";

export const OPTIONS = options;
export const GET = route<{ id: string }>(async (req, { id }) => json({ receipt: await myReceipt(await requireCustomer(req), id) }));
