import { body, json, options, route } from "@/server/api";
import { OtpVerify } from "@/server/api-schemas";
import { verifyOtp } from "@/server/auth/customer";
import { signInResponse } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => json(await signInResponse(await verifyOtp(await body(req, OtpVerify)))));
