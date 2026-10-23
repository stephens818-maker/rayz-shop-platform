import { z } from "zod";
import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { AppError } from "@/server/errors";
import { rejectRawCard } from "@/server/mobile/cards";
import { previewPayment } from "@/server/mobile/pay";

export const OPTIONS = options;

const Preview = z.object({
  paymentMethodId: z.string().optional(),
  tipCents: z.number().int().nonnegative().optional(),
  wallet: z.boolean().optional(),
});

export const POST = route<{ code: string }>(async (req, { code }) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("bad_request", "Body must be JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("bad_request", "Body must be JSON");
  rejectRawCard(raw as Record<string, unknown>);
  return json(await previewPayment(await requireCustomer(req), code, Preview.parse(raw)));
});
