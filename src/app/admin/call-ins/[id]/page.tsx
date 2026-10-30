import type { Metadata } from "next";
import Link from "next/link";
import { ReasonTag } from "@/components/reason-picker";
import { Badge, Notice, PageHeader } from "@/components/ui";
import { CALL_IN_KIND_LABEL, quietLabel } from "@/domain/outreach";
import { can, guardPage, reasonViewer } from "@/server/auth/staff";
import { callInDetail, loadOutreachRules } from "@/server/call-ins";
import { liveTwilio } from "@/server/notifications/providers";
import { requireInTenant } from "@/server/tenant";
import { CancelCallIn, OutreachBoard } from "../client";

export const metadata: Metadata = { title: "Call-in" };

export default async function CallInPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/call-ins/[id]");
  await requireInTenant(ctx, "call_in", id);
  const [d, rules] = await Promise.all([callInDetail(id, reasonViewer(ctx), { shopIds: ctx.shopIds, checkFree: true }), loadOutreachRules()]);
  const c = d.callIn;
  const rows = d.outreach.filter((r) => ctx.shopIds.includes(r.shopId));
  const canMark = can(ctx, "callins.mark") || (can(ctx, "callins.mark_own") && c.staffId === ctx.staff.id);
  const flagged = rows.filter((r) => r.flaggedAt && r.status !== "rebooked" && r.status !== "declined" && r.status !== "cancelled").length;
  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.staffLabel} called in {c.cancelledAt && <Badge>cancelled</Badge>}
          </span>
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.range} · {c.shopName ?? "All their shops"} · <ReasonTag reason={c.reasonShown} />
            {!c.reasonShown.hidden && c.kind !== "other" && c.reasonShown.label !== CALL_IN_KIND_LABEL[c.kind] && <span>{CALL_IN_KIND_LABEL[c.kind]}</span>}
          </span>
        }
        actions={
          <div className="flex items-center gap-3">
            <Link href="/admin/call-ins" className="text-sm text-zinc-600 underline underline-offset-2">
              All call-ins
            </Link>
            {canMark && !c.cancelledAt && <CancelCallIn id={c.id} />}
          </div>
        }
      />
      {!liveTwilio() && <Notice tone="blue">Twilio isn&apos;t connected, so texts and calls go to the outbox and the call simulator instead of real phones.</Notice>}
      {flagged > 0 && <Notice tone="red">{flagged === 1 ? "One client needs" : `${flagged} clients need`} a call from the shop: outreach couldn&apos;t reach them, or got no answer.</Notice>}
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">Nobody was booked with {c.staffLabel} in this time.</p>
      ) : (
        <OutreachBoard callInId={c.id} rows={rows} canOutreach={can(ctx, "callins.outreach")} canVoice={can(ctx, "callins.voice")} cancelled={!!c.cancelledAt} />
      )}
      <p className="text-xs text-zinc-500">
        No answer after {rules.retryAfterHours} h: one more try, then flagged for staff. Quiet hours {quietLabel(rules)}. Rebook links last {rules.linkTtlHours} h and only work for their appointment. Replies land in the shop
        inbox.
      </p>
    </div>
  );
}
