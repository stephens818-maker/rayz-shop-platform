"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { endOtherWebSessions, endWebSession } from "@/server/auth/sessions";
import { stepUp } from "@/server/auth/sign-in-guard";
import { requireStaff } from "@/server/auth/staff";
import { notFound } from "@/server/errors";
import { endMyStaffAppSession } from "@/server/staff-api/sign-in";

/** Confirms it's them (password, or their authenticator code once set up) before reveal, export or refund. */
export async function stepUpAction(input: { password?: string; code?: string }) {
  return safe(async () => {
    const ctx = await requireStaff();
    const v = z.object({ password: z.string().max(200).optional(), code: z.string().max(12).optional() }).parse(input);
    return stepUp(ctx, v);
  });
}

/** Signs out one of their browsers. */
export async function endMyWebSessionAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const sid = z.uuid().parse(id);
    if (!(await endWebSession(ctx.staff.id, sid))) throw notFound("Sign-in");
    await audit(ctx.actor, "staff.session_end", "staff", ctx.staff.id, { via: "web", own: sid === ctx.session?.id }, null);
    revalidatePath("/admin/my-security");
    return null;
  });
}

/** Signs out every browser but this one. */
export async function endOtherWebSessionsAction() {
  return safe(async () => {
    const ctx = await requireStaff();
    const n = await endOtherWebSessions(ctx.staff.id, ctx.session?.id ?? null);
    await audit(ctx.actor, "staff.session_end_others", "staff", ctx.staff.id, { via: "web", ended: n }, null);
    revalidatePath("/admin/my-security");
    return { ended: n };
  });
}

/** Signs out one of their phones in the staff app. */
export async function endMyAppSessionAction(sessionId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await endMyStaffAppSession(ctx.staff.id, z.uuid().parse(sessionId));
    await audit(ctx.actor, "staff.session_end", "staff", ctx.staff.id, { via: "staff_app" }, null);
    revalidatePath("/admin/my-security");
    return null;
  });
}
