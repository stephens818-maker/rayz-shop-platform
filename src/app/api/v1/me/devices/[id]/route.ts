import { body, json, options, route } from "@/server/api";
import { UpdateDevice } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { revokeDevice, updateDevice } from "@/server/customer-devices";

export const OPTIONS = options;
export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const customerId = await requireCustomer(req);
  return json({ device: await updateDevice(customerId, id, await body(req, UpdateDevice)) });
});
export const DELETE = route<{ id: string }>(async (req, { id }) => {
  await revokeDevice(await requireCustomer(req), id);
  return new Response(null, { status: 204 });
});
