import { z } from "zod";
import { body, json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { listDevices, registerDevice } from "@/server/mobile/devices";

const Register = z.object({
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm", "expo"]),
  token: z.string().min(8).max(4096),
  appVersion: z.string().max(40).optional(),
  osVersion: z.string().max(40).optional(),
  locale: z.string().max(20).optional(),
});

export const OPTIONS = options;
export const GET = route(async (req) => json(await listDevices(await requireCustomer(req))));
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, Register);
  return json(await registerDevice(id, b), 201);
});
