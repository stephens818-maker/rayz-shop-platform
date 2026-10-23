import { body, json, options, route } from "@/server/api";
import { OtpVerify } from "@/server/api-schemas";
import { verifyOtp } from "@/server/auth/customer";
import { authBody } from "@/server/mobile/auth-response";
import { readClient } from "@/server/mobile/client";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const info = readClient(req);
  const r = await verifyOtp({ ...(await body(req, OtpVerify)), locale: info.locale });
  if ("verified" in r) return json(r);
  return json(await authBody(r));
});
