import { clientIp } from "@/lib/client-ip";
import { body, json, options, route } from "@/server/api";
import { OtpStart } from "@/server/api-schemas";
import { startOtp } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => json(await startOtp({ ...(await body(req, OtpStart)), ip: clientIp(req.headers) })));
