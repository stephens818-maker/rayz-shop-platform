import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { notificationJobs, shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { inboxThreads } from "@/server/messaging";
import { liveTwilio, smsProvider, voiceProvider } from "@/server/notifications/providers";
import { simulatedCalls } from "@/server/shop-line";
import { OutreachCallButtons, SimForm } from "./client";

export const metadata: Metadata = { title: "Call and text simulator" };

const SHOP_LINE_KINDS = ["callin_reassign", "callin_rebook", "callin_link", "missed_call", "shop_reply"];

/** Runs the same handlers as the Twilio webhooks, so call-in outreach, replies and missed calls can be tried without a phone. */
export default async function SimulatorPage() {
  const ctx = await guardPage("/admin/notifications/simulator");
  if (liveTwilio())
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader title="Call and text simulator" />
        <Notice tone="blue">Twilio is connected, so the simulator is off. Use a real phone.</Notice>
      </div>
    );
  const policy = await clientPolicy(ctx);
  const [shopRows, threads, calls, texts] = await Promise.all([
    db.select({ id: shops.id, name: shops.name, line: shops.twilioNumber }).from(shops).where(inArray(shops.id, ctx.shopIds)).orderBy(shops.name),
    inboxThreads(ctx.shopIds, { limit: 30 }),
    simulatedCalls(30),
    db
      .select()
      .from(notificationJobs)
      .where(and(eq(notificationJobs.channel, "sms"), inArray(notificationJobs.kind, SHOP_LINE_KINDS), inArray(notificationJobs.shopId, ctx.shopIds)))
      .orderBy(desc(notificationJobs.createdAt))
      .limit(15),
  ]);
  const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
  const mine = calls.filter((c) => c.j.shopId && ctx.shopIds.includes(c.j.shopId) && c.j.kind === "callin_voice");
  const who = (phone: string) => policy.show("phone", phone) ?? "A client";
  const smsOn = smsProvider().name === "simulator";
  const voiceOn = voiceProvider().name === "simulator";
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Call and text simulator"
        subtitle="For trying the shop line before Twilio is connected. Texts and calls here run exactly what Twilio's webhooks run."
        actions={
          <Link href="/admin/notifications" className="text-sm text-zinc-600 underline underline-offset-2">
            Notifications
          </Link>
        }
      />
      {(!smsOn || !voiceOn) && (
        <Notice>
          Set NOTIFICATIONS_SMS_PROVIDER and NOTIFICATIONS_VOICE_PROVIDER to <code>simulator</code> so outgoing texts and calls show up here as sent. Now: texts {smsProvider().name}, calls {voiceProvider().name}.
        </Notice>
      )}
      <SimForm shops={shopRows.map((s) => ({ id: s.id, name: s.name, line: s.line }))} threads={threads.map((t) => ({ id: t.id, shopId: t.shopId, label: t.firstName ? `${t.firstName} ${t.lastName ?? ""}`.trim() : who(t.phone) }))} />

      <Card>
        <CardHeader title="Automated call-in calls" subtitle="Placed by call-in outreach. Pick how the client answers." />
        {mine.length === 0 ? (
          <div className="p-4">
            <Empty title="No automated calls yet">Send an automated call from a call-in.</Empty>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Placed</Th>
                <Th>Shop</Th>
                <Th>To</Th>
                <Th>Script</Th>
                <Th>Answer as</Th>
              </tr>
            </thead>
            <tbody>
              {mine.map(({ j, shopName: s }) => (
                <tr key={j.id} className="align-top">
                  <Td className="whitespace-nowrap">{formatDateTime(j.createdAt)}</Td>
                  <Td>{s}</Td>
                  <Td className="whitespace-nowrap">{who(j.to)}</Td>
                  <Td className="max-w-sm text-xs text-zinc-600">{j.body}</Td>
                  <Td>{j.status === "sent" ? <OutreachCallButtons jobId={j.id} /> : <Badge>{j.status}</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Texts from shop numbers" subtitle="What the client's phone got, links included, so you can open a rebook link." />
        {texts.length === 0 ? (
          <div className="p-4">
            <Empty title="No texts yet" />
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 text-sm">
            {texts.map((j) => (
              <li key={j.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>{formatDateTime(j.createdAt)}</span>
                  <span>
                    {shopName.get(j.shopId ?? "")} → {who(j.to)}
                  </span>
                  <Badge tone={j.status === "sent" ? "green" : j.status === "suppressed" ? "gray" : "amber"}>{j.status}</Badge>
                  {j.lastError && <span>{j.lastError}</span>}
                </div>
                <div className="whitespace-pre-wrap break-words">
                  {j.body.split(/(https?:\/\/\S+)/g).map((part, i) =>
                    /^https?:\/\//.test(part) ? (
                      <a key={i} className="text-brand-700 underline" href={part} target="_blank" rel="noreferrer">
                        {part}
                      </a>
                    ) : (
                      part
                    ),
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
