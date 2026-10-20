import { body, json, options, route } from "@/server/api";
import { OtpVerify } from "@/server/api-schemas";
import { verifyOtp } from "@/server/auth/customer";
import { publicMe } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const r = await verifyOtp(await body(req, OtpVerify));
  if (r.needsProfile) return json({ needsProfile: true });
  return json({
    needsProfile: false,
    isNew: r.isNew,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    tokenType: r.tokenType,
    expiresIn: r.expiresIn,
    customer: await publicMe(r.customer.id),
  });
});
