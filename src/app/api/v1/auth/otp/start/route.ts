import { body, json, options, route } from "@/server/api";
import { OtpStart } from "@/server/api-schemas";
import { startOtp } from "@/server/auth/customer";
import { readClient } from "@/server/mobile/client";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const info = readClient(req);
  return json(await startOtp(await body(req, OtpStart), { ip: info.ip, deviceKey: info.deviceKey, androidHash: info.androidHash, locale: info.locale }));
});
