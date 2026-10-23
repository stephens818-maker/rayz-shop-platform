import { body, json, options, route } from "@/server/api";
import { RegisterDevice } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { listDevices, registerDevice } from "@/server/mobile/devices";

export const OPTIONS = options;
export const GET = route(async (req) => json(await listDevices(await requireCustomer(req))));
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, RegisterDevice);
  return json(await registerDevice(id, b), 201);
});
