import { body, json, options, route } from "@/server/api";
import { StepUpVerify } from "@/server/api-schemas";
import { verifyStepUp } from "@/server/auth/customer";
import { signInResponse } from "@/server/public";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const b = await body(req, StepUpVerify);
  return json(await signInResponse(await verifyStepUp(b.selectionToken, b.code, b.deviceName)));
});
