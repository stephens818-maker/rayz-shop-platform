"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { markIsolvedSentAction, undoIsolvedSentAction } from "./actions";

/** "Mark sent" once the period is approved and reconciled (locking it, if it isn't yet), and "Undo" with a reason if the upload didn't go through. */
export function IsolvedSentControl({ start, end, label, sent, blocked, locks = false }: { start: string; end: string; label: string; sent: boolean; blocked: string | null; locks?: boolean }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open)
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={!sent && !!blocked}
          title={!sent && blocked ? blocked : sent ? `Take the sent mark off ${label}` : `Mark ${label}'s iSolved file uploaded${locks ? ": this locks the period" : ""}`}
          onClick={() => setOpen(true)}
          data-testid={sent ? "isolved-undo" : "isolved-mark-sent"}
        >
          {sent ? "Undo sent" : "Mark sent"}
        </Button>
        {!sent && blocked && <span className="max-w-[16rem] text-right text-[11px] text-zinc-500">{blocked}</span>}
        {!sent && !blocked && locks && (
          <span className="max-w-[16rem] text-right text-[11px] text-zinc-500" data-testid="isolved-send-locks">
            Marking it sent locks the period. Later changes go to the next open period as flagged adjustments.
          </span>
        )}
      </span>
    );
  const submit = () =>
    run(
      () => (sent ? undoIsolvedSentAction(start, end, text) : markIsolvedSentAction(start, end, text)),
      () => {
        setOpen(false);
        setText("");
      },
      sent ? `${label} is back to approved` : `${label} marked sent to iSolved${locks ? " and locked" : ""}`,
    );
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="flex items-center gap-1">
        <Input
          aria-label={sent ? "Why it wasn't sent" : "Note (optional)"}
          placeholder={sent ? "Why it wasn't sent" : "Note (optional)"}
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          className="h-8 w-48 text-xs"
          autoFocus
        />
        <Button size="sm" disabled={pending || (sent && text.trim().length < 3)} onClick={submit}>
          {pending ? "Saving…" : sent ? "Undo" : "Mark sent"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
