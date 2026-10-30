import type { Metadata } from "next";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, notificationJobs, shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, LinkButton, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { CLIENT_MESSAGE_KINDS, DELIVERY_LABEL, DELIVERY_TONE, MESSAGE_KIND_LABEL, deliveryState } from "@/domain/notification-delivery";
import { redactLinks } from "@/domain/outreach";
import { demoMode } from "@/lib/deployment";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { emailProvider, liveTwilio, smsProvider, voiceProvider } from "@/server/notifications/providers";
import { notificationsByShop } from "@/server/notification-history";
import { inShops } from "@/server/tenant";
import { ProcessNowButton } from "./process-button";

export const metadata: Metadata = { title: "Notifications" };

const STATUSES = ["pending", "sent", "suppressed", "failed", "cancelled"] as const;


const RANGES = [7, 30, 90] as const;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ status?: string; days?: string }> }) {
  const sp = await searchParams;
  const days = RANGES.find((d) => String(d) === sp.days) ?? 30;
  const ctx = await guardPage("/admin/notifications");
  const policy = await clientPolicy(ctx);
  const recipient = (j: { kind: string; channel: string; to: string }) =>
    CLIENT_MESSAGE_KINDS.has(j.kind) ? (policy.show(j.channel === "email" ? "email" : "phone", j.to) ?? "hidden") : j.to;
  const status = STATUSES.find((s) => s === sp.status);

  // Managers only see jobs for their shops (a booking's shop, or the shop a purchase order or stock alert is for);
  // brand admins also see OTP and waitlist texts.
  const jobShop = sql`coalesce(${notificationJobs.shopId}, ${appointments.shopId})`;
  const scope: SQL | undefined = ctx.brandWide && !ctx.currentShopId ? undefined : inShops({ shopIds: ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds }, jobShop);
  const where = and(scope, status ? eq(notificationJobs.status, status) : undefined);

  const [byShop, counts, jobs] = await Promise.all([
    notificationsByShop(ctx, new Date(Date.now() - days * 86_400_000)),
    db
      .select({ status: notificationJobs.status, n: sql<number>`count(*)::int` })
      .from(notificationJobs)
      .leftJoin(appointments, eq(appointments.id, notificationJobs.appointmentId))
      .where(scope)
      .groupBy(notificationJobs.status),
    db
      .select({ j: notificationJobs, shop: shops.name, code: appointments.code })
      .from(notificationJobs)
      .leftJoin(appointments, eq(appointments.id, notificationJobs.appointmentId))
      .leftJoin(shops, eq(shops.id, jobShop))
      .where(where)
      .orderBy(desc(notificationJobs.runAt))
      .limit(150),
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const sms = smsProvider();
  const email = emailProvider();
  const off = !sms.enabled && !email.enabled;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Notifications"
        subtitle="Confirmations and 24h / 2h reminders queued for each booking, plus purchase orders emailed to vendors and low-stock alerts. Cancelling or rescheduling a booking cancels its pending reminders."
        actions={
          can(ctx, "notifications.send") ? (
            <div className="flex items-center gap-2">
              {!liveTwilio() && (
                <LinkButton variant="secondary" href="/admin/notifications/simulator">
                  Call and text simulator
                </LinkButton>
              )}
              <ProcessNowButton />
            </div>
          ) : undefined
        }
      />
      {off && (
        <Notice>
          Sending is off. Jobs are still queued and marked “suppressed” when due, so nothing reaches customers. Set NOTIFICATIONS_SMS_PROVIDER / NOTIFICATIONS_EMAIL_PROVIDER to{" "}
          <code>console</code> to log messages, or wire Twilio / Resend before go-live.
        </Notice>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-7">
        <Stat label="SMS provider" value={sms.name} hint={sms.enabled ? "sending" : "off"} />
        <Stat label="Email provider" value={email.name} hint={email.enabled ? "sending" : "off"} />
        <Stat label="Voice provider" value={voiceProvider().name} hint={voiceProvider().enabled ? "calling" : "off"} />
        {(["pending", "sent", "suppressed", "failed"] as const).map((s) => (
          <a key={s} href={status === s ? "/admin/notifications" : `/admin/notifications?status=${s}`} className="block">
            <Stat label={s[0].toUpperCase() + s.slice(1)} value={count(s)} hint={status === s ? "filtered · clear" : "filter"} />
          </a>
        ))}
      </div>
      <Card className="mt-4" data-testid="notifications-by-shop">
        <CardHeader
          title="By shop"
          subtitle={`Last ${days} days. Delivered means the carrier or mail server confirmed it. Cost is an estimate at Campaign Center's rates per text segment and per email.`}
          action={
            <div className="flex gap-1 text-sm">
              {RANGES.map((d) => (
                <a key={d} href={`/admin/notifications?days=${d}${status ? `&status=${status}` : ""}`} className={d === days ? "rounded-md bg-zinc-900 px-2 py-1 text-white" : "rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100"}>
                  {d} days
                </a>
              ))}
            </div>
          }
        />
        {byShop.length === 0 ? (
          <Empty title={`No messages in the last ${days} days`} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Shop</Th>
                <Th>Channel</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Queued</Th>
                <Th className="text-right">Sent</Th>
                <Th className="text-right">Delivered</Th>
                <Th className="text-right">Failed</Th>
                <Th className="text-right">Opted out</Th>
                <Th className="text-right">Not sent (off)</Th>
                <Th className="text-right">Text segments</Th>
                <Th className="text-right">Est. cost</Th>
              </tr>
            </thead>
            <tbody>
              {byShop.map((r) => (
                <tr key={`${r.shopId}-${r.channel}`}>
                  <Td>{r.shop}</Td>
                  <Td className="uppercase text-xs text-zinc-500">{r.channel}</Td>
                  <Td className="text-right tabular-nums">{r.total}</Td>
                  <Td className="text-right tabular-nums">{r.queued}</Td>
                  <Td className="text-right tabular-nums">{r.sent}</Td>
                  <Td className="text-right tabular-nums">{r.delivered}</Td>
                  <Td className="text-right tabular-nums">{r.failed}</Td>
                  <Td className="text-right tabular-nums">{r.optedOut}</Td>
                  <Td className="text-right tabular-nums">{r.notSent}</Td>
                  <Td className="text-right tabular-nums">{r.channel === "sms" ? r.segments : "—"}</Td>
                  <Td className="text-right tabular-nums">{money(r.costCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card className="mt-4">
        <CardHeader title={status ? `${status[0].toUpperCase() + status.slice(1)} jobs` : "Recent jobs"} subtitle="Newest first, up to 150." />
        {jobs.length === 0 ? (
          <Empty title="No notifications yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Send at</Th>
                <Th>Type</Th>
                <Th>To</Th>
                <Th>Message</Th>
                <Th>For</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(({ j, shop, code }) => (
                <tr key={j.id} className="align-top">
                  <Td className="whitespace-nowrap">{formatDateTime(j.runAt)}</Td>
                  <Td className="whitespace-nowrap">
                    {MESSAGE_KIND_LABEL[j.kind] ?? j.kind}
                    <div className="text-xs uppercase text-zinc-400">{j.channel}</div>
                  </Td>
                  <Td className="whitespace-nowrap">{recipient(j)}</Td>
                  <Td className="max-w-md text-xs text-zinc-600">
                    {j.subject && j.channel === "email" && <div className="font-medium text-zinc-800">{j.subject}</div>}
                    <div className="whitespace-pre-line">{redactLinks(j.body, { receipts: !demoMode() })}</div>
                    {j.kind !== "saved_report" && (j.attachments ?? []).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {(j.attachments ?? []).map((a, i) => (
                          <a key={a.filename} className="text-brand-700 underline" href={`/admin/notifications/${j.id}/attachment?i=${i}`}>
                            {a.filename}
                          </a>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {code ? (
                      <>
                        <span className="font-mono">{code}</span>
                        <div className="text-zinc-400">{shop}</div>
                      </>
                    ) : j.purchaseOrderId ? (
                      <>
                        <a className="underline" href={`/admin/purchase-orders/${j.purchaseOrderId}`}>
                          Purchase order
                        </a>
                        <div className="text-zinc-400">{shop}</div>
                      </>
                    ) : shop ? (
                      shop
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    <Badge tone={DELIVERY_TONE[deliveryState(j)]}>{DELIVERY_LABEL[deliveryState(j)]}</Badge>
                    {j.lastError && <div className="mt-1 max-w-40 text-xs text-red-600">{j.lastError}</div>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
