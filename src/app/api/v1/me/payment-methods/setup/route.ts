import { json, options, route } from "@/server/api";
import { SetupCard } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { AppError } from "@/server/errors";
import { rejectRawCard, setupCard } from "@/server/mobile/cards";

export const OPTIONS = options;

export const POST = route(async (req) => {
  const customerId = await requireCustomer(req);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("bad_request", "Body must be JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("bad_request", "Body must be JSON");
  rejectRawCard(raw as Record<string, unknown>);
  const input = SetupCard.parse(raw);
  return json(await setupCard(customerId, input));
});
