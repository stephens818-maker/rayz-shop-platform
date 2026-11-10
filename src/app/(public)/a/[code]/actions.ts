"use server";

import { z } from "zod";
import { safe } from "@/server/action";
import { setBookingTip } from "@/server/booking-tips";

/** The appointment's code is its private link, as for cancel and reschedule. */
export async function setBookingTipAction(raw: { code: string; cents: number }) {
  return safe(async () => {
    const p = z.object({ code: z.string().min(4).max(32), cents: z.number().int() }).parse(raw);
    return setBookingTip(p.code, p.cents);
  });
}
