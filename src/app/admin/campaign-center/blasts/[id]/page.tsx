import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { FREQ_LABEL, recurrenceLabel } from "@/domain/campaign-schedule";
import { SHOP_TZ, formatDateTime, todayLocal } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { decodeFilter } from "@/domain/client-filters";
import { clientPolicy } from "@/server/client-privacy";
import { filterOptions, panelSees } from "@/server/client-filters";
import { couponOptions, listBlasts } from "@/server/marketing/campaigns";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { listTemplates } from "@/server/marketing/templates";
import { celebrateDraft } from "@/server/milestones/views";
import { inTenant } from "@/server/tenant";
import { KpiSkeleton } from "../../kpis";
import { CampaignResultsSection } from "../../results-section";
import { BlastActions } from "../blast-actions";
import { BLAST_STATUS } from "../status";
import { BlastWizard } from "./wizard";

export const metadata: Metadata = { title: "Blast" };
export const dynamic = "force-dynamic";

export default async function BlastPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string; shops?: string; done?: string; queued?: string; skipped?: string; celebrate?: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/blasts/[id]");
  const { id } = await params;
  const sp = await searchParams;
  const mayCreate = can(ctx, "campaign_center.create");
  const maySend = can(ctx, "campaign_center.send");
  const blast = id === "new" || !(await inTenant(ctx, "marketing_campaign", id)) ? null : ((await listBlasts(ctx)).find((b) => b.id === id) ?? null);
  if (id === "new" ? !mayCreate : !blast) notFound();
  const shops = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const policy = await clientPolicy(ctx);
  const [settings, coupons, options, library] = await Promise.all([loadMarketingSettings(), couponOptions(todayLocal(), { includeUnusable: true }), filterOptions(ctx, policy), listTemplates(ctx)]);
  const celebrate = id === "new" && sp.celebrate && /^[0-9a-f-]{36}$/i.test(sp.celebrate) ? await celebrateDraft(ctx, sp.celebrate) : null;
  const initial = celebrate ? celebrate.segment : id === "new" && sp.f ? decodeFilter(sp.f) : undefined;
  const initialShops = celebrate ? celebrate.shopIds.filter((s) => shops.some((x) => x.id === s)) : id === "new" && sp.shops ? sp.shops.split(",").filter((s) => shops.some((x) => x.id === s)) : undefined;
  const status = blast ? (BLAST_STATUS[blast.status] ?? { label: blast.status, tone: "gray" as const }) : null;
  const count = (x: string | undefined) => Math.max(0, Number.parseInt(x ?? "", 10) || 0);
  const done =
    blast && sp.done === "scheduled" && blast.scheduledAt
      ? `Scheduled for ${formatDateTime(blast.scheduledAt)}${blast.recurrence ? `, then ${FREQ_LABEL[blast.recurrence.freq].toLowerCase()}` : ""}.`
      : blast && sp.done === "sent"
        ? `Sent: ${count(sp.queued)} queued${count(sp.skipped) ? `, ${count(sp.skipped)} skipped (limits, consent or the holdout group)` : ""}. Messages due in quiet hours go out when they end.`
        : null;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={blast ? blast.name : "New blast"}
        subtitle={
          <>
            <Link href="/admin/campaign-center/blasts" className="underline">
              Blasts
            </Link>{" "}
            · Goes only to clients who agreed to marketing, once each, outside quiet hours ({settings.quietStart}–{settings.quietEnd} local) and within the brand&apos;s limits.
          </>
        }
        actions={blast && <BlastActions id={blast.id} name={blast.name} status={blast.status} mayWrite={mayCreate} maySend={maySend} mayManage={blast.inScope} />}
      />
      {done && <Notice tone="green">{done}</Notice>}
      {id === "new" && sp.celebrate && (celebrate ? <Notice tone="blue">Started from the brand&rsquo;s approved milestone template: the barber&rsquo;s recent clients, their first name only. Review the wording and audience before it goes out.</Notice> : <Notice>That milestone can&rsquo;t be shared with clients (it&rsquo;s not one about the work, the barber keeps theirs private, or the brand turned client celebrations off).</Notice>)}
      {blast && status && (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span>{blast.campaignType === "promotion" ? "Promotion" : "Quick update"}</span>
          {blast.recurrence && <span>{recurrenceLabel(blast.recurrence, SHOP_TZ)}</span>}
          {blast.sentAt && (
            <span>
              Last sent {formatDateTime(blast.sentAt)} · {blast.sent} messages
            </span>
          )}
          {(blast.status === "scheduled" || blast.status === "paused") && blast.scheduledAt && (
            <span>
              {blast.status === "paused" ? "Paused; was due" : "Next send"} {formatDateTime(blast.scheduledAt)}
            </span>
          )}
          {blast.status === "testing" && blast.ab?.testEndsAt && <span>A/B test running; the winner goes out {formatDateTime(blast.ab.testEndsAt)}</span>}
          {blast.holdoutPct > 0 && <Badge>Holdout {blast.holdoutPct}%</Badge>}
          {blast.sendTimeOpt && <Badge>Usual booking time</Badge>}
          {blast.aiDrafted && <Badge tone="violet">{blast.reviewedAt ? "AI draft, reviewed" : "AI draft, not reviewed yet"}</Badge>}
        </Card>
      )}
      <BlastWizard
        key={blast?.id ?? "new"}
        blast={
          blast && {
            id: blast.id,
            name: blast.name,
            status: blast.status,
            channels: blast.channels,
            templates: blast.templates,
            segment: blast.segment,
            promoId: blast.promoId,
            shopIds: blast.shopIds,
            scheduledAt: blast.scheduledAt?.toISOString() ?? null,
            sentAt: blast.sentAt?.toISOString() ?? null,
            sent: blast.sent,
            campaignType: blast.campaignType,
            recurrence: blast.recurrence ? { freq: blast.recurrence.freq, endsOn: blast.recurrence.endsOn } : null,
            ab: blast.ab ? { testPct: blast.ab.testPct, metric: blast.ab.metric, waitHours: blast.ab.waitHours, b: blast.ab.b } : null,
            holdoutPct: blast.holdoutPct,
            sendTimeOpt: blast.sendTimeOpt,
            templateId: blast.templateId,
            aiDrafted: blast.aiDrafted && !blast.reviewedAt,
          }
        }
        mayEdit={blast ? blast.mayEdit : mayCreate}
        mayWrite={mayCreate}
        maySend={maySend}
        everyLocation={ctx.brandWide && mayCreate}
        shops={shops}
        options={options}
        sees={panelSees(ctx, policy)}
        initialSegment={initial}
        initialShopIds={initialShops}
        initialDraft={celebrate ? { name: celebrate.name, templateId: celebrate.templateId, channels: celebrate.channels, templates: celebrate.templates } : undefined}
        coupons={coupons}
        library={library.filter((t) => t.status === "approved" && (!t.purpose || t.id === celebrate?.templateId)).map((t) => ({ id: t.id, name: t.name, campaignType: t.campaignType, description: t.description, channels: t.channels, templates: t.templates }))}
        settings={{ address: settings.address, quietStart: settings.quietStart, quietEnd: settings.quietEnd, capPerWeek: settings.capPerWeek, capPerMonth: settings.capPerMonth, attributionDays: settings.attributionDays }}
      />
      {blast && blast.status !== "draft" && (
        <Suspense fallback={<KpiSkeleton />}>
          <CampaignResultsSection ctx={ctx} campaign={{ id: blast.id, ab: blast.ab }} />
        </Suspense>
      )}
    </div>
  );
}
