import { json, options, route } from "@/server/api";
import { PaymentRequest } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { AppError } from "@/server/errors";
import { rejectRawCard } from "@/server/mobile/cards";
import { payAppointment } from "@/server/mobile/pay";

export const OPTIONS = options;

export const POST = route<{ code: string }>(async (req, { code }) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("bad_request", "Body must be JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("bad_request", "Body must be JSON");
  rejectRawCard(raw as Record<string, unknown>);
  const key = req.headers.get("idempotency-key");
  return json(await payAppointment(await requireCustomer(req), code, PaymentRequest.parse(raw), key));
});
