"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TIP_METHODS } from "@/domain/tips";
import { safe } from "@/server/action";
import { StaffContext, authorize } from "@/server/auth/staff";
import { addVersion, assertEditable, compensationAccess, deleteVersion, loadCompensationSettings, saveCustomValues } from "@/server/compensation";
import { AppError } from "@/server/errors";

const num = z.number();
const version = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date this takes effect"),
  hourlyRateCents: num.nullable(),
  shopHourlyRates: z.array(z.object({ shopId: z.uuid(), cents: num })).max(50),
  servicePct: num.nullable(),
  serviceOverrides: z.array(z.object({ kind: z.enum(["service", "category"]), ref: z.string().min(1).max(100), pct: num })).max(100),
  serviceTiers: z.array(z.object({ fromCents: num, pct: num })).max(10),
  tierMode: z.enum(["step", "marginal"]),
  productPct: num.nullable(),
  boothRentCents: num.nullable(),
  boothRentFrequency: z.enum(["weekly", "biweekly", "monthly"]).nullable(),
  guaranteeCents: num.nullable(),
  guaranteePer: z.enum(["pay_period", "week", "month", "year"]).nullable(),
  tipMethod: z.enum(TIP_METHODS).nullable(),
  note: z
    .string()
    .max(500)
    .nullable()
    .transform((s) => (s?.trim() ? s.trim() : null)),
});
export type VersionForm = z.input<typeof version>;

/** Someone who can edit this person's compensation, with compensation turned on. */
async function editor(staffId: string): Promise<StaffContext> {
  const ctx = await authorize("compensation.edit");
  if (!(await loadCompensationSettings()).enabled) throw new AppError("bad_request", "Compensation fields are turned off for the brand");
  assertEditable(await compensationAccess(ctx, staffId));
  return ctx;
}

const refresh = (staffId: string) => revalidatePath(`/admin/staff/${staffId}/compensation`);

export async function addVersionAction(staffId: string, input: VersionForm) {
  return safe(async () => {
    const ctx = await editor(z.uuid().parse(staffId));
    const v = await addVersion(staffId, version.parse(input), ctx.actor);
    refresh(staffId);
    return v.id;
  });
}

export async function deleteVersionAction(staffId: string, versionId: string) {
  return safe(async () => {
    const ctx = await editor(z.uuid().parse(staffId));
    await deleteVersion(staffId, z.uuid().parse(versionId), ctx.actor);
    refresh(staffId);
  });
}

export async function saveCustomValuesAction(staffId: string, values: Record<string, string>) {
  return safe(async () => {
    const ctx = await editor(z.uuid().parse(staffId));
    const n = await saveCustomValues(staffId, z.record(z.uuid(), z.string().max(400)).parse(values), ctx.actor);
    refresh(staffId);
    return n;
  });
}
