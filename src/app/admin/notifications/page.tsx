import type { Metadata } from "next";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, notificationJobs, shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, LinkButton, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { redactLinks } from "@/domain/outreach";
import { demoMode } from "@/lib/deployment";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { emailProvider, liveTwilio, smsProvider, voiceProvider } from "@/server/notifications/providers";
import { inShops } from "@/server/tenant";
import { ProcessNowButton } from "./process-button";

export const metadata: Metadata = { title: "Notifications" };

const STATUSES = ["pending", "sent", "suppressed", "failed", "cancelled"] as const;
const TONE = { pending: "blue", sent: "green", suppressed: "gray", failed: "red", cancelled: "gray" } as const;
const KIND_LABEL: Record<string, string> = {
  confirmation: "Confirmation",
  reminder_24h: "24h reminder",
  reminder_2h: "2h reminder",
  cancellation: "Cancellation",
  reschedule: "Rescheduled",
  otp: "Sign-in code",
  waitlist_ready: "Waitlist: ready",
  purchase_order: "Purchase order",
  low_stock: "Low stock",
  staff_text: "Text from staff",
  staff_call: "Call through shop line",
  privacy_alert: "Client data alert",
  time_off_reschedule: "Time off: please reschedule",
  time_off_decision: "Time off decision",
  clock_forgot_out: "Forgotten clock-out",
  ft_status_change: "Full-time / part-time change",
  clock_late_in: "Not clocked in for first client",
  clock_affected: "Clients booked over a break or clock-out",
  callin_reassign: "Call-in: moved to another barber",
  callin_rebook: "Call-in: rebook link",
  callin_voice: "Call-in: automated call",
  callin_link: "Call-in: link after a call",
  missed_call: "Missed call text",
  shop_reply: "Shop text",
  fill_offer: "Today: open-chair offer",
  rebook_nudge: "Today: due to rebook",
  no_show_reminder: "Today: extra reminder",
  running_late: "Today: running late",
  digest: "Morning digest",
  receipt: "Receipt",
  review_request: "Google review request",
  marketing: "Marketing",
};
/** Jobs sent to a client: their number or email shows as the viewer may see it. */
const TO_CLIENT = new Set(["confirmation", "reminder_24h", "reminder_2h", "cancellation", "reschedule", "otp", "waitlist_ready", "staff_text", "staff_call", "time_off_reschedule", "callin_reassign", "callin_rebook", "callin_voice", "callin_link", "missed_call", "shop_reply", "fill_offer", "rebook_nudge", "no_show_reminder", "running_late", "receipt", "review_request", "marketing"]);

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/notifications");
  const policy = await clientPolicy(ctx);
  const recipient = (j: { kind: string; channel: string; to: string }) =>
    TO_CLIENT.has(j.kind) ? (policy.show(j.channel === "email" ? "email" : "phone", j.to) ?? "hidden") : j.to;
  const status = STATUSES.find((s) => s === sp.status);

  // Managers only see jobs for their shops (a booking's shop, or the shop a purchase order or stock alert is for);
  // brand admins also see OTP and waitlist texts.
  const jobShop = sql`coalesce(${notificationJobs.shopId}, ${appointments.shopId})`;
  const scope: SQL | undefined = ctx.brandWide && !ctx.currentShopId ? undefined : inShops({ shopIds: ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds }, jobShop);
  const where = and(scope, status ? eq(notificationJobs.status, status) : undefined);

  const [counts, jobs] = await Promise.all([
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
                    {KIND_LABEL[j.kind] ?? j.kind}
                    <div className="text-xs uppercase text-zinc-400">{j.channel}</div>
                  </Td>
                  <Td className="whitespace-nowrap">{recipient(j)}</Td>
                  <Td className="max-w-md text-xs text-zinc-600">
                    {j.subject && j.channel === "email" && <div className="font-medium text-zinc-800">{j.subject}</div>}
                    <div className="whitespace-pre-line">{redactLinks(j.body, { receipts: !demoMode() })}</div>
                    {(j.attachments ?? []).length > 0 && (
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
                    <Badge tone={TONE[j.status]}>{j.status}</Badge>
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
