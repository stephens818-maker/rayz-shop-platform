import { json, options, route } from "@/server/api";
import { appConfig, clientPlatform } from "@/server/app-config";

export const OPTIONS = options;
export const GET = route(async (req) => json(await appConfig(clientPlatform(req), req.headers.get("x-app-version"))));
