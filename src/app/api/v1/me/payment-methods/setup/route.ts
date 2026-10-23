import { z } from "zod";
import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { AppError } from "@/server/errors";
import { rejectRawCard, setupCard } from "@/server/mobile/cards";

export const OPTIONS = options;

const Setup = z.object({
  funding: z.enum(["credit", "debit", "prepaid"]).optional(),
  wallet: z.boolean().optional(),
  paymentMethodId: z.string().min(1).optional(),
});

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
  const input = Setup.parse(raw);
  return json(await setupCard(customerId, input));
});
