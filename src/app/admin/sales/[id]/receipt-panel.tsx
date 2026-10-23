"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Input, Notice, cx } from "@/components/ui";
import { RECEIPT_PURPOSE_LABEL, type ReceiptPurpose } from "@/domain/receipts";
import { sendReceiptAction } from "../actions";

export interface OnFile {
  /** In full, or masked (***-***-1234) where this person's Client data settings don't show it. */
  phone: string | null;
  email: string | null;
  smsStopped: boolean;
  emailStopped: boolean;
}
export interface ReceiptHistoryRow {
  id: string;
  at: string;
  channel: "sms" | "email" | "none";
  masked: string | null;
  purpose: ReceiptPurpose;
  status: string;
  by: string | null;
}

const STATUS: Record<string, string> = {
  pending: "Queued",
  sent: "Sent",
  failed: "Failed",
  suppressed: "Held: not sent by the provider",
  cancelled: "Cancelled",
  opted_out: "Not sent: opted out",
  no_consent: "Not sent: no consent",
  recent: "Not sent: asked recently",
  few_visits: "Not sent: before the review visit",
  snoozed: "Not sent: tapped the review link lately",
  none: "",
};
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Text, email or (at checkout) no receipt: what's on file is offered first, without showing more of it than this person may see. */
function Chooser({ saleId, onFile, atCheckout, onDone }: { saleId: string; onFile: OnFile; atCheckout: boolean; onDone: (msg: string) => void }) {
  const [mode, setMode] = useState<"sms" | "email" | null>(null);
  const [typing, setTyping] = useState(false);
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const send = (input: { channel: "sms" | "email" | "none"; onFile: boolean; to?: string }) =>
    start(async () => {
      setError(null);
      const r = await sendReceiptAction(saleId, { ...input, atCheckout });
      if (!r.ok) return setError(r.error);
      setMode(null);
      setTyping(false);
      setTo("");
      onDone(r.data.status === "none" ? "No receipt." : `Receipt ${input.channel === "sms" ? "texted" : "emailed"} to ${r.data.masked}.`);
    });
  const file = mode === "sms" ? (onFile.smsStopped ? null : onFile.phone) : mode === "email" ? (onFile.emailStopped ? null : onFile.email) : null;
  const stopped = mode === "sms" ? onFile.smsStopped && !!onFile.phone : mode === "email" ? onFile.emailStopped && !!onFile.email : false;
  return (
    <div className="space-y-2">
      <div className={cx("grid gap-2", atCheckout ? "grid-cols-3" : "grid-cols-2")}>
        {(["sms", "email"] as const).map((c) => (
          <Button
            key={c}
            size="sm"
            variant={mode === c ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => {
              setMode(c);
              setTyping(false);
              setError(null);
            }}
            data-testid={`receipt-${c}`}
          >
            {c === "sms" ? "Text" : "Email"}
          </Button>
        ))}
        {atCheckout && (
          <Button size="sm" variant="secondary" className="whitespace-nowrap px-2" disabled={pending} onClick={() => send({ channel: "none", onFile: false })} data-testid="receipt-none">
            No receipt
          </Button>
        )}
      </div>
      {mode && (
        <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
          {stopped && (
            <p className="text-xs text-amber-800">
              {mode === "sms" ? "The number on file replied STOP, so it can't be texted." : "The email on file turned off receipt emails."}
            </p>
          )}
          {file && !typing ? (
            <>
              <Button size="sm" className="w-full" disabled={pending} onClick={() => send({ channel: mode, onFile: true })} data-testid="receipt-onfile">
                Send to {file}
              </Button>
              <button type="button" className="block text-xs text-zinc-600 underline" onClick={() => setTyping(true)}>
                Use a different {mode === "sms" ? "number" : "email"}
              </button>
            </>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send({ channel: mode, onFile: false, to });
              }}
            >
              <Input
                aria-label={mode === "sms" ? "Mobile number" : "Email"}
                inputMode={mode === "sms" ? "tel" : "email"}
                type={mode === "sms" ? "tel" : "email"}
                placeholder={mode === "sms" ? "(319) 555-0100" : "name@example.com"}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                autoFocus
              />
              <Button size="sm" disabled={pending || !to.trim()}>
                Send
              </Button>
            </form>
          )}
          {!file && !typing && <p className="text-[11px] text-zinc-500">Nothing on file that can be used. Enter what the client gives you.</p>}
        </div>
      )}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

/** The sidebar on a ticket: the counter's receipt question right after paying, then resend and the history. */
export function ReceiptPanel({ saleId, onFile, atCheckout, history, highlight }: { saleId: string; onFile: OnFile; atCheckout: boolean; history: ReceiptHistoryRow[]; highlight?: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card className={cx(highlight && atCheckout && "outline-2 outline-brand-600")} data-testid="receipt-panel">
      <CardHeader title={atCheckout ? "How would they like the receipt?" : "Receipt"} subtitle={atCheckout ? "A text with a link, or an email. No paper." : "Digital: a text with a link, or an email."} />
      <div className="space-y-3 p-4">
        <Chooser
          saleId={saleId}
          onFile={onFile}
          atCheckout={atCheckout}
          onDone={(m) => {
            setMsg(m);
            router.refresh();
          }}
        />
        {msg && <Notice tone="green">{msg}</Notice>}
        {history.length > 0 && (
          <ul className="space-y-1.5 border-t border-zinc-100 pt-3 text-xs text-zinc-600" data-testid="receipt-history">
            {history.map((h) => (
              <li key={h.id}>
                <span className="font-medium text-zinc-800">{h.channel === "none" ? (h.purpose === "review" ? "Not sent" : "No receipt wanted") : `${h.channel === "sms" ? "Texted" : "Emailed"} to ${h.masked}`}</span>
                {" · "}
                {RECEIPT_PURPOSE_LABEL[h.purpose]}
                {STATUS[h.status] ? ` · ${STATUS[h.status]}` : ""}
                <span className="block text-zinc-400">
                  {when(h.at)}
                  {h.by ? ` · ${h.by}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** A ticket in the client's purchase history: send its receipt again. */
export function ResendReceipt({ saleId, onFile, last }: { saleId: string; onFile: OnFile; last: string | null }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="min-w-44 text-xs">
      {!open && (
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">{msg ?? last ?? "Not sent"}</span>
          <button type="button" className="font-medium text-zinc-800 underline" onClick={() => setOpen(true)} data-testid={`resend-${saleId}`}>
            Send
          </button>
        </div>
      )}
      {open && (
        <div className="w-56 space-y-1">
          <Chooser
            saleId={saleId}
            onFile={onFile}
            atCheckout={false}
            onDone={(m) => {
              setMsg(m);
              setOpen(false);
            }}
          />
          <button type="button" className="text-zinc-500 underline" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
