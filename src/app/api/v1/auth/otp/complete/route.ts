import { body, json, options, route } from "@/server/api";
import { OtpComplete } from "@/server/api-schemas";
import { completeSignIn } from "@/server/auth/customer";
import { signInResponse } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => json(await signInResponse(await completeSignIn(await body(req, OtpComplete)))));
