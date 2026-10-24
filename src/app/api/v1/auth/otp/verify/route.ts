import { body, json, options, route } from "@/server/api";
import { OtpVerify } from "@/server/api-schemas";
import { verifyOtp } from "@/server/auth/customer";
import { tokenResponse } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const r = await verifyOtp(await body(req, OtpVerify));
  if (r.needsProfile) return json({ needsProfile: true, selectionToken: r.selectionToken });
  if (r.chooseProfile) return json({ needsProfile: false, chooseProfile: true, selectionToken: r.selectionToken, profiles: r.profiles });
  return json(await tokenResponse(r));
});
