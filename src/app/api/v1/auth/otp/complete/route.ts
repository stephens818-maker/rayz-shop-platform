import { body, json, options, route } from "@/server/api";
import { OtpComplete } from "@/server/api-schemas";
import { completeSignIn } from "@/server/auth/customer";
import { tokenResponse } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => json(await tokenResponse(await completeSignIn(await body(req, OtpComplete)))));
