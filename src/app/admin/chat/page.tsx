import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { staffChatFor, staffMessagesFor } from "@/server/staff-chat";
import { ChatComposer, DeleteOwn, DirectMessage, Moderate } from "./box";

export const metadata: Metadata = { title: "Staff chat" };

export default async function StaffChatPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const ctx = await guardPage("/admin/chat");
  const sp = await searchParams;
  const { channels, people, canModerate } = await staffChatFor(ctx);
  const current = channels.find((c) => c.id === sp.c) ?? channels[0] ?? null;
  const thread = current ? await staffMessagesFor(ctx, current.id) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Staff chat"
        subtitle="Your shop, all shops, and direct messages. This is staff only. Use a client's first name and last initial. Don't put a phone number or email here."
      />
      <DirectMessage people={people} />
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Card>
          <CardHeader title="Channels" />
          <ul className="p-2 text-sm">
            {channels.map((c) => (
              <li key={c.id}>
                <Link href={`/admin/chat?c=${c.id}`} className={c.id === current?.id ? "block rounded-md bg-zinc-100 px-2 py-1.5 font-medium" : "block rounded-md px-2 py-1.5 hover:bg-zinc-50"}>
                  {c.title}
                  <span className="ml-1 text-xs text-zinc-400">{c.kind === "dm" ? "DM" : c.kind === "brand" ? "Brand" : "Shop"}</span>
                </Link>
              </li>
            ))}
            {!channels.length && <li className="px-2 py-1.5 text-zinc-500">No channel yet.</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title={current?.title ?? "Chat"} subtitle={current?.kind === "brand" ? "Managers post here." : "Messages stay on file."} />
          <div className="space-y-3 p-4">
            <ul className="max-h-96 space-y-2 overflow-y-auto text-sm" data-testid="staff-chat">
              {thread?.messages.map((m) => (
                <li key={m.id} className="rounded-md bg-zinc-50 px-2 py-1.5">
                  <div className="text-[11px] text-zinc-500">
                    {m.author} · {new Date(m.at).toLocaleString()}
                    {m.reported ? " · reported" : ""}
                    {m.mine && m.body !== "Removed" && <DeleteOwn messageId={m.id} />}
                    {canModerate && m.body !== "Removed" && <Moderate messageId={m.id} />}
                  </div>
                  <div className="whitespace-pre-wrap text-zinc-800">{m.body}</div>
                </li>
              ))}
              {thread && !thread.messages.length && <li className="text-zinc-500">No messages yet. Say hello.</li>}
            </ul>
            {current && thread && <ChatComposer channelId={current.id} canPost={thread.canPost} />}
          </div>
        </Card>
      </div>
    </div>
  );
}
