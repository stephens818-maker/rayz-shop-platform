import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { rebookForCustomer } from "@/server/mobile/rebook";

export const OPTIONS = options;

export const POST = route<{ code: string }>(async (req, { code }) => {
  const appointment = await rebookForCustomer(await requireCustomer(req), code, req.headers.get("idempotency-key"));
  return json({ appointment }, 201);
});
