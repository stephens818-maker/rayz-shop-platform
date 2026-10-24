"use server";

import { safe } from "@/server/action";
import { customerActor } from "@/server/audit";
import { cancelGroup, groupRescheduleOptions, publicGroup, rescheduleGroup } from "@/server/booking-groups";
import { AppError } from "@/server/errors";
import type { GroupOptionsView } from "@/server/booking-groups";

/** Anyone holding the group's link may change it, like a single booking's /a/{code} link. */
const actor = customerActor("link");

export async function cancelGroupAction(code: string) {
  return safe(async () => publicGroup(await cancelGroup(String(code), { actor, byCustomer: true, reason: "Cancelled from the family booking link" })));
}

export async function groupOptionsAction(code: string, date: string) {
  return safe(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new AppError("bad_request", "Pick a day");
    return groupRescheduleOptions(String(code), String(date), { staff: false });
  });
}

/** A seat taken in the meantime moves nobody; the times that still work come back with the message. */
export async function rescheduleGroupAction(code: string, input: unknown) {
  return safe(async () => {
    try {
      return { group: publicGroup(await rescheduleGroup(String(code), input, { actor, byCustomer: true })), message: null, alternatives: null };
    } catch (e) {
      if (e instanceof AppError && e.code === "slot_unavailable") {
        const alt = (e.details as { alternatives?: GroupOptionsView } | undefined)?.alternatives ?? null;
        return { group: null, message: e.message, alternatives: alt };
      }
      throw e;
    }
  });
}
