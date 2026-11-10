"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { alertDismissals, notificationJobs } from "@/db/schema";
import { durationLabel } from "@/domain/today";
import { endOfLocalDay, todayLocal, addDays } from "@/lib/time";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { can, requireStaff } from "@/server/auth/staff";
import { AppError, forbidden } from "@/server/errors";
import { whoOf } from "@/server/inventory/ledger";
import { createPos } from "@/server/inventory/purchasing";
import { processDueJobs } from "@/server/notifications/queue";
import { nudgeAppointments, sendFillCampaign, sendRebookCampaign } from "@/server/outreach-campaigns";
import { todayAlerts, viewerOf } from "@/server/today";

/** The alert as the server sees it for this person now; the browser only names it. */
async function liveAlert(key: string) {
  const ctx = await requireStaff();
  const alert = (await todayAlerts(viewerOf(ctx))).find((a) => a.key === key);
  if (!alert) throw new AppError("conflict", "That alert has cleared or isn't yours to act on. Refresh to see what's current.");
  return { ctx, alert };
}

const NEEDS = {
  fill: "clients.campaigns",
  rebook: "clients.campaigns",
  no_show_reminder: "calendar.manage",
  running_late: "calendar.manage",
  draft_po: "po.create",
  retry_notifications: "notifications.send",
} as const;

export async function runAlertAction(key: string) {
  return safe(async () => {
    const { ctx, alert } = await liveAlert(key);
    const a = alert.action;
    if (!a) throw new AppError("bad_request", "Nothing to do for this one");
    if (!can(ctx, NEEDS[a.kind])) throw forbidden();
    const who = { actor: ctx.actor, staffId: ctx.staff.id, shopIds: ctx.shopIds };
    const p = a.payload;
    let message: string;
    let href: string | null = null;
    switch (a.kind) {
      case "fill": {
        const r = await sendFillCampaign(String(p.shopId), (alert.items ?? []).map((i) => i.label), who);
        message = r.sent ? `Texted ${r.sent} client${r.sent === 1 ? "" : "s"} about today's openings.` : "Nobody left to text: they've all heard from us this week.";
        break;
      }
      case "rebook": {
        const r = await sendRebookCampaign(String(p.shopId), who);
        message = r.sent ? `Texted ${r.sent} regular${r.sent === 1 ? "" : "s"} to rebook.` : "Nobody left to text: they've all heard from us this week.";
        break;
      }
      case "no_show_reminder":
      case "running_late": {
        const r = await nudgeAppointments(a.kind, p.appointmentIds as string[], who, a.kind === "running_late" ? { delay: durationLabel(Number(p.delayMin)) } : {});
        message = `Sent to ${r.sent} client${r.sent === 1 ? "" : "s"}.${r.skipped ? ` ${r.skipped} skipped (no texts or emails on, or already told).` : ""}`;
        break;
      }
      case "draft_po": {
        const { created: made } = await createPos(whoOf(ctx), { picks: (p.vendorIds as string[]).map((vendorId) => ({ shopId: String(p.shopId), vendorId })), fill: "suggested" });
        if (!made.length) throw new AppError("conflict", "Nothing to order any more: it's already on a draft or on its way.");
        message = `Drafted ${made.length === 1 ? `PO ${made[0].number}` : `${made.length} purchase orders`}. Review and send when ready.`;
        href = made.length === 1 ? `/admin/purchase-orders/${made[0].id}` : "/admin/purchase-orders";
        break;
      }
      case "retry_notifications": {
        const jobIds = p.jobIds as string[];
        await db
          .update(notificationJobs)
          .set({ status: "pending", attempts: 0, lastError: null, runAt: new Date() })
          .where(and(inArray(notificationJobs.id, jobIds), eq(notificationJobs.status, "failed"), inArray(notificationJobs.shopId, ctx.shopIds)));
        const r = await processDueJobs({ ids: jobIds });
        await audit(ctx.actor, "notifications.retry", "notification_jobs", null, { jobs: jobIds.length, ...r }, null);
        message = `Retried: ${r.sent} sent, ${r.failed} failed again${r.suppressed ? `, ${r.suppressed} suppressed` : ""}.`;
        break;
      }
    }
    revalidatePath("/admin");
    return { message, href };
  });
}

/** Hides an alert for everyone who'd see it, until tomorrow or for a week. */
export async function dismissAlertAction(key: string, days: 1 | 7) {
  return safe(async () => {
    const { ctx, alert } = await liveAlert(key);
    const until = endOfLocalDay(addDays(todayLocal(), days === 7 ? 6 : 0));
    await db
      .insert(alertDismissals)
      .values({ alertKey: key, shopId: alert.shopId, until, staffId: ctx.staff.id })
      .onConflictDoUpdate({ target: alertDismissals.alertKey, set: { until, staffId: ctx.staff.id } });
    await audit(ctx.actor, "today.dismiss", "alert", key, { type: alert.type, days }, alert.shopId);
    revalidatePath("/admin");
    return null;
  });
}
