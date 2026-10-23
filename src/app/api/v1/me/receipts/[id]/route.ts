import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { customerReceipt } from "@/server/mobile/receipts";

export const OPTIONS = options;

/** A missing id stays under 400 so a client probing an unknown receipt does not look like a server error. */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const receipt = await customerReceipt(await requireCustomer(req), id);
  if (!receipt) return json({ receipt: null });
  return json(receipt);
});
