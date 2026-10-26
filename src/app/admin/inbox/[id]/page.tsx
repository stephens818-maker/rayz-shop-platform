import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Notice, PageHeader, cx } from "@/components/ui";
import { redactLinks } from "@/domain/outreach";
import { formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { CALL_KIND_LABEL, CALL_STATUS_LABEL, REPLY_MAX, callsWith, markThreadRead, replyProblem, threadView } from "@/server/messaging";
import { requireInTenant } from "@/server/tenant";
import { ReplyBox } from "./reply";

export const metadata: Metadata = { title: "Conversation" };

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/inbox/[id]");
  await requireInTenant(ctx, "message_thread", id);
  const [v, policy] = await Promise.all([threadView(id), clientPolicy(ctx)]);
  const [problem, calls] = await Promise.all([replyProblem(v.thread), callsWith(v.thread.phone, [v.thread.shopId], 10)]);
  if (v.thread.unread) await markThreadRead(id);
  const shown = policy.show("phone", v.thread.phone);
  const title = v.people.length === 1 ? `${v.people[0].firstName} ${v.people[0].lastName ?? ""}`.trim() : v.people.length > 1 ? v.people.map((p) => p.firstName).join(", ") : (shown ?? "A client");
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={title}
        subtitle={
          <>
            Ray&apos;z {v.shop.name}
            {shown && ` · ${shown}`}
            {v.people.length > 1 && " · shared number"}
          </>
        }
        actions={
          <Link href="/admin/inbox" className="text-sm text-zinc-600 underline underline-offset-2">
            Inbox
          </Link>
        }
      />
      {v.people.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          {v.people.map((p) => (
            <Link key={p.id} href={`/admin/customers/${p.id}`} className="rounded-full px-3 py-1 ring-1 ring-zinc-300 hover:bg-zinc-50">
              {policy.name(p.firstName, p.lastName)}
              {!p.smsOptIn && <span className="text-zinc-500"> · no texts</span>}
            </Link>
          ))}
        </div>
      )}
      <Card className="space-y-2 p-4">
        {v.messages.map(({ m, staffLabel, jobStatus, delivered, jobError }) =>
          m.direction === "note" ? (
            <div key={m.id} className="text-center text-xs text-zinc-500">
              {m.body} · {formatDateTime(m.createdAt)}
            </div>
          ) : (
            <div key={m.id} className={cx("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
              <div className={cx("max-w-[80%] rounded-2xl px-3 py-2 text-sm", m.direction === "out" ? "bg-ink-900 text-white" : "bg-zinc-100 text-zinc-900")}>
                <div className="whitespace-pre-wrap break-words">{redactLinks(m.body)}</div>
                <div className={cx("mt-1 text-[11px]", m.direction === "out" ? "text-zinc-300" : "text-zinc-500")}>
                  {formatDateTime(m.createdAt)}
                  {m.direction === "out" && (m.auto ? " · automatic" : staffLabel ? ` · ${staffLabel}` : "")}
                  {m.direction === "out" && jobStatus && ` · ${delivered ? "delivered" : jobStatus === "sent" ? "sent" : jobStatus}`}
                  {jobError && ` (${jobError})`}
                </div>
              </div>
            </div>
          ),
        )}
      </Card>
      {problem ? <Notice tone="amber">{problem}</Notice> : <ReplyBox threadId={id} max={REPLY_MAX} shop={v.shop.name} />}
      {calls.length > 0 && (
        <Card>
          <CardHeader title="Calls with this number" />
          <ul className="divide-y divide-zinc-100 text-sm">
            {calls.map(({ c, staffLabel }) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span>
                  {CALL_KIND_LABEL[c.kind]}
                  {staffLabel && ` · ${staffLabel}`}
                </span>
                <span className="flex items-center gap-2 text-zinc-500">
                  <Badge tone={c.status === "missed" || c.status === "no_answer" ? "amber" : "gray"}>{CALL_STATUS_LABEL[c.status]}</Badge>
                  {c.autoTextSent && <span>texted a link</span>}
                  {formatDateTime(c.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
