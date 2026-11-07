import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, Notice, PageHeader, cx } from "@/components/ui";
import { redactLinks } from "@/domain/outreach";
import { formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { inboxThreads } from "@/server/messaging";
import { liveTwilio } from "@/server/notifications/providers";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage() {
  const ctx = await guardPage("/admin/inbox");
  const [threads, policy] = await Promise.all([inboxThreads(ctx.shopIds), clientPolicy(ctx)]);
  const multi = ctx.shopIds.length > 1;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Inbox" subtitle="Texts to and from each shop's number: replies to call-in outreach, missed-call texts and anything clients send. Replies go from the shop's number." />
      {!liveTwilio() && <Notice tone="blue">Twilio isn&apos;t connected. Use the call simulator under Notifications to text or call a shop number.</Notice>}
      {threads.length === 0 ? (
        <Empty title="No texts yet">When a client texts a shop&apos;s number, or the shop texts them, the conversation shows here.</Empty>
      ) : (
        <Card className="divide-y divide-zinc-100">
          {threads.map((t) => {
            const name = t.firstName ? policy.name(t.firstName, t.lastName) : (policy.show("phone", t.phone) ?? "A client");
            return (
              <Link key={t.id} href={`/admin/inbox/${t.id}`} className={cx("flex items-start gap-3 px-4 py-3 hover:bg-zinc-50", t.unread > 0 && "bg-brand-50/40")}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cx("truncate", t.unread > 0 ? "font-semibold" : "font-medium")}>{name}</span>
                    {multi && <span className="text-xs text-zinc-500">{t.shopName}</span>}
                    {t.unread > 0 && <Badge tone="blue">{t.unread} new</Badge>}
                  </div>
                  <div className="truncate text-sm text-zinc-600">
                    {t.previewDirection === "out" ? "You: " : t.previewDirection === "note" ? "· " : ""}
                    {t.preview && redactLinks(t.preview)}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-zinc-500">{formatDateTime(t.lastMessageAt)}</div>
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}
