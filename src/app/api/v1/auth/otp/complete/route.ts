import { body, json, options, route } from "@/server/api";
import { OtpComplete } from "@/server/api-schemas";
import { clientPlatform } from "@/server/app-config";
import { completeSignIn } from "@/server/auth/customer";
import { signInResponse } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => json(await signInResponse(await completeSignIn({ ...(await body(req, OtpComplete)), requireAge: !!clientPlatform(req) }))));
