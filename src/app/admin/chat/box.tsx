"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAction } from "@/components/use-action";
import { Button, Notice, Textarea } from "@/components/ui";
import { moderateChatAction, openDmAction, postChatAction } from "./actions";

export function ChatComposer({ channelId, canPost }: { channelId: string; canPost: boolean }) {
  const { pending, error, run } = useAction();
  const [body, setBody] = useState("");
  if (!canPost) return <p className="text-sm text-zinc-500">A manager posts in the all-shops channel. You can still read it.</p>;
  return (
    <div className="space-y-2">
      <Textarea rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message the shop. No client phone numbers or emails." aria-label="Message" />
      <Button
        disabled={pending || !body.trim()}
        onClick={() =>
          run(
            () => postChatAction(channelId, body),
            () => setBody(""),
            "Sent",
          )
        }
      >
        Send
      </Button>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function DirectMessage({ people }: { people: { id: string; label: string }[] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [id, setId] = useState(people[0]?.id ?? "");
  if (!people.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm text-zinc-600" htmlFor="dm">
        Direct message
      </label>
      <select id="dm" className="rounded-md border border-zinc-300 px-2 py-1 text-sm" value={id} onChange={(e) => setId(e.target.value)}>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || !id}
        onClick={() => run(() => openDmAction(id), (channel) => router.push(`/admin/chat?c=${channel}`))}
      >
        Open
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function Moderate({ messageId }: { messageId: string }) {
  const { pending, run } = useAction();
  return (
    <span className="ml-2 space-x-2 text-[11px]">
      <button type="button" className="underline" disabled={pending} onClick={() => run(() => moderateChatAction(messageId, "report"), undefined, "Reported")}>
        Report
      </button>
      <button type="button" className="underline" disabled={pending} onClick={() => run(() => moderateChatAction(messageId, "delete"), undefined, "Removed")}>
        Remove
      </button>
    </span>
  );
}
