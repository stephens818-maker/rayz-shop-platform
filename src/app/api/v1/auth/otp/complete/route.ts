import { body, json, options, route } from "@/server/api";
import { OtpComplete } from "@/server/api-schemas";
import { completeSignIn } from "@/server/auth/customer";
import { authBody } from "@/server/mobile/auth-response";
import { readClient } from "@/server/mobile/client";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const info = readClient(req);
  const b = await body(req, OtpComplete);
  const r = await completeSignIn({ ...b, requireAdult: info.client === "ios" || info.client === "android" });
  return json(await authBody(r));
});
