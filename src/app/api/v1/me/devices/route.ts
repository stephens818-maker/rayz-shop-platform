import { body, json, options, route } from "@/server/api";
import { RegisterDevice } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { listDevices, registerDevice } from "@/server/customer-devices";

export const OPTIONS = options;
export const GET = route(async (req) => json({ devices: await listDevices(await requireCustomer(req)) }));
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  return json({ device: await registerDevice(id, await body(req, RegisterDevice)) }, 201);
});
