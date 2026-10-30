import { body, json, options, route } from "@/server/api";
import { StepUpStart } from "@/server/api-schemas";
import { startStepUp } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => json(await startStepUp((await body(req, StepUpStart)).selectionToken)));
