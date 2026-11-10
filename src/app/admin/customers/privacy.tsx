"use client";

import { useState, useTransition, type ReactNode, type SyntheticEvent } from "react";
import { Button, Input, Textarea } from "@/components/ui";
import type { Level } from "@/domain/client-privacy";
import { textButtonState } from "@/domain/text-client";
import { withStepUp } from "../step-up";
import { contactClientAction, revealClientFieldAction } from "./actions";

const stop = (e: SyntheticEvent) => e.preventDefault();

/**
 * Client lists can't be copied, dragged out or printed from the page. A screenshot still works, so
 * this only slows bulk copying down; the export permission and the lookup limits do the rest.
 */
export function NoCopy({ children, what = "client details" }: { children: ReactNode; what?: string }) {
  return (
    <>
      <div data-no-copy className="select-none print:hidden" onCopy={stop} onCut={stop} onDragStart={stop}>
        {children}
      </div>
      <p className="hidden p-6 text-sm print:block">Printing {what} is turned off to protect client data.</p>
    </>
  );
}

/** A client detail as the viewer may see it, with "Reveal" for a masked one when they're allowed. */
export function Masked({
  customerId,
  field,
  value,
  level,
  canReveal,
  empty = "—",
}: {
  customerId: string;
  field: string;
  value: string | null;
  level: Level;
  canReveal: boolean;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (level === "hidden") return <span className="text-xs text-zinc-400">Hidden</span>;
  if (!value) return <span className="text-zinc-400">{empty}</span>;
  if (level === "full" || shown) {
    return (
      <span>
        {shown ?? value}
        {shown && <span className="ml-2 text-[11px] text-amber-700">revealed · logged</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-zinc-600">{value}</span>
      {canReveal && !open && (
        <button type="button" className="text-xs text-brand-700 underline" onClick={() => setOpen(true)}>
          Reveal
        </button>
      )}
      {open && (
        <span className="flex w-full items-center gap-2">
          <Input
            className="h-8 text-xs"
            placeholder="Why do you need it? (logged)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Reason for revealing"
            autoFocus
          />
          <Button
            size="sm"
            disabled={pending || reason.trim().length < 4}
            onClick={() =>
              start(async () => {
                const r = await withStepUp(() => revealClientFieldAction({ customerId, field, reason }));
                if (!r.ok) return setError(r.error);
                setShown(r.data.value ?? "—");
                setOpen(false);
              })
            }
          >
            Show
          </Button>
        </span>
      )}
      {error && <span className="w-full text-xs text-red-600">{error}</span>}
    </span>
  );
}

/** Call or text through the shop line. The number is looked up on the server and never shown. Text stays on screen even when it can't be sent. */
export function ContactClient({
  customerId,
  canText,
  hasPhone,
  canMessage = true,
  compact = false,
}: {
  customerId: string;
  canText: boolean;
  hasPhone: boolean;
  canMessage?: boolean;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "text">("idle");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  void compact;
  const text = textButtonState({ customerId: customerId || null, hasPhone, smsOptIn: canText, canMessage });
  const send = (channel: "sms" | "call") =>
    start(async () => {
      setError(null);
      const r = await contactClientAction(customerId, { channel, message });
      if (!r.ok) return setError(r.error);
      const how = { sent: "sent", suppressed: "queued (sending is off)", pending: "queued", failed: "failed" }[r.data.status as string] ?? r.data.status;
      setNote(channel === "call" ? `Calling ${r.data.to} through the shop line: ${how}.` : `Text to ${r.data.to}: ${how}.`);
      setMode("idle");
      setMessage("");
    });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={pending || !customerId || !hasPhone} onClick={() => send("call")}>
          Call through shop line
        </Button>
        <Button size="sm" variant="secondary" disabled={pending || !text.enabled} title={text.reason ?? undefined} aria-label="Text" onClick={() => setMode(mode === "text" ? "idle" : "text")}>
          Text
        </Button>
      </div>
      {text.reason && <p className="text-xs text-zinc-500">{text.reason}</p>}
      {mode === "text" && (
        <div className="space-y-2">
          <Textarea
            rows={2}
            maxLength={320}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Running 10 minutes behind, see you soon!"
            aria-label="Text message"
          />
          <Button size="sm" disabled={pending || !message.trim()} onClick={() => send("sms")}>
            Send text
          </Button>
        </div>
      )}
      {note && <p className="text-xs text-emerald-700">{note}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
