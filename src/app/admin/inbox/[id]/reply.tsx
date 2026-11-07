"use client";

import { useState } from "react";
import { useAction } from "@/components/use-action";
import { Button, Notice, Textarea } from "@/components/ui";
import { replyAction } from "../actions";

export function ReplyBox({ threadId, max, shop }: { threadId: string; max: number; shop: string }) {
  const { pending, error, run } = useAction();
  const [body, setBody] = useState("");
  return (
    <div className="space-y-2">
      <Textarea rows={3} maxLength={max} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Reply as Ray'z ${shop}`} aria-label="Reply" />
      <div className="flex items-center gap-3">
        <Button disabled={pending || !body.trim()} onClick={() => run(() => replyAction(threadId, body), () => setBody(""))}>
          {pending ? "Sending…" : "Send text"}
        </Button>
        <span className="text-xs text-zinc-500">
          {body.length}/{max} · Starts with &ldquo;Ray&apos;z {shop}:&rdquo;
        </span>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}
