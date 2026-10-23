import { json, options, route } from "@/server/api";
import { startDeletion } from "@/server/mobile/account-deletion";

export const OPTIONS = options;
export const POST = route(async (req) => json(await startDeletion(req)));
