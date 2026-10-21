import type { Metadata } from "next";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, notificationJobs, shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { formatPhone } from "@/lib/phone";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { maskPhone } from "@/server/customers";
import { emailProvider, smsProvider } from "@/server/notifications/providers";
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
};

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/notifications");
  const contact = can(ctx, "clients.contact");
  const status = STATUSES.find((s) => s === sp.status);

  // Managers only see jobs tied to their shop's appointments; brand admins also see OTP and waitlist texts.
  const scope: SQL | undefined = ctx.brandWide && !ctx.currentShopId ? undefined : inArray(appointments.shopId, ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds);
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
      .leftJoin(shops, eq(shops.id, appointments.shopId))
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
        subtitle="Confirmations and 24h / 2h reminders queued for each booking. Cancelling or rescheduling a booking cancels its pending reminders."
        actions={can(ctx, "notifications.send") ? <ProcessNowButton /> : undefined}
      />
      {off && (
        <Notice>
          Sending is off. Jobs are still queued and marked “suppressed” when due, so nothing reaches customers. Set NOTIFICATIONS_SMS_PROVIDER /
          NOTIFICATIONS_EMAIL_PROVIDER to <code>console</code> to log messages, or wire Twilio / Resend before go-live.
        </Notice>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="SMS provider" value={sms.name} hint={sms.enabled ? "sending" : "off"} />
        <Stat label="Email provider" value={email.name} hint={email.enabled ? "sending" : "off"} />
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
                <Th>Booking</Th>
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
                  <Td className="whitespace-nowrap">{!contact ? (j.channel === "sms" ? (maskPhone(j.to) ?? "—") : "hidden") : j.channel === "sms" ? formatPhone(j.to) || j.to : j.to}</Td>
                  <Td className="max-w-md text-xs text-zinc-600">{j.body}</Td>
                  <Td className="whitespace-nowrap text-xs">
                    {code ? (
                      <>
                        <span className="font-mono">{code}</span>
                        <div className="text-zinc-400">{shop}</div>
                      </>
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
