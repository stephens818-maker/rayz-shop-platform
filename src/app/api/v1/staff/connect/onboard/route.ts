import { json, options, route } from "@/server/api";
import { StaffOnboardRequest } from "@/server/api-schemas";
import { AppError } from "@/server/errors";
import { barberFromBearer, staffOnboardingLink } from "@/server/mobile/staff-connect";

/** Stripe-hosted Account Link for a recipient account. No bank details or tax id are accepted here. */
export const OPTIONS = options;
export const POST = route(async (req) => {
  const barber = await barberFromBearer(req);
  if (barber === "invalid" || !barber) throw new AppError("unauthorized", "Sign in required");
  let shop: string | undefined;
  const text = await req.text();
  if (text.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError("bad_request", "Body must be JSON");
    }
    shop = StaffOnboardRequest.parse(raw).shop;
  }
  return json(await staffOnboardingLink(barber.id, shop));
});
