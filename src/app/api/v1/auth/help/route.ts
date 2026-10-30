import { clientIp } from "@/lib/client-ip";
import { body, json, options, route } from "@/server/api";
import { SignInHelp } from "@/server/api-schemas";
import { requestSignInHelp } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => json(await requestSignInHelp({ ...(await body(req, SignInHelp)), ip: clientIp(req.headers) }), 202));
