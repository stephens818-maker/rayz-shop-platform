import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { revokeDevice } from "@/server/mobile/devices";

export const OPTIONS = options;
export const DELETE = route<{ id: string }>(async (req, { id }) => {
  await revokeDevice(await requireCustomer(req), id);
  return json({ ok: true });
});
