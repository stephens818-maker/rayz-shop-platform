"use client";

import { useState } from "react";
import { MessageHistoryList, type MessageHistoryLine } from "@/components/message-history";
import { appointmentMessagesAction, appointmentReplyAction } from "./actions";

type PanelThread = {
  threadId: string | null;
  unread: number;
  messages: { id: string; direction: "in" | "out" | "note"; body: string; at: string; staffLabel: string | null }[];
  replyBlock: string | null;
};

const QUICK = ["Running a few minutes late.", "We're ready for you.", "See you soon."];

/** "Messages" on the appointment panel: the shop's thread with this client, loaded when opened. */
export function AppointmentMessages({ appointmentId }: { appointmentId: string }) {
  const [history, setHistory] = useState<MessageHistoryLine[] | null>(null);
  const [thread, setThread] = useState<PanelThread | null>(null);
  const [canText, setCanText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const load = () => {
    void appointmentMessagesAction(appointmentId).then((r) => {
      if (!r.ok) return setError(r.error);
      setHistory(r.data.history);
      setThread(r.data.thread);
      setCanText(r.data.canText);
      setError(null);
    });
  };
  const send = (body: string) => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    void appointmentReplyAction(appointmentId, text).then((r) => {
      setSending(false);
      if (!r.ok) return setError(r.error);
      setDraft("");
      load();
    });
  };
  return (
    <details
      className="rounded-lg ring-1 ring-zinc-200"
      onToggle={(e) => {
        if (!e.currentTarget.open || thread) return;
        load();
      }}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-700">
        Messages to the client
        {thread && thread.unread > 0 ? <span className="ml-2 rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{thread.unread}</span> : null}
      </summary>
      <div className="space-y-2 px-3 pb-3">
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        {!thread ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <>
            {thread.messages.length ? (
              <ul className="max-h-64 space-y-1.5 overflow-y-auto text-sm" data-testid="panel-thread">
                {thread.messages.map((m) => (
                  <li key={m.id} className={m.direction === "in" ? "rounded-md bg-zinc-100 px-2 py-1" : "rounded-md bg-white px-2 py-1 ring-1 ring-zinc-200"}>
                    <div className="text-[11px] text-zinc-500">
                      {m.direction === "in" ? "Client" : m.direction === "note" ? "Note" : m.staffLabel || "Shop"} · {new Date(m.at).toLocaleString()}
                    </div>
                    <div className="whitespace-pre-wrap text-zinc-800">{m.body}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">No texts with this client yet.</p>
            )}
            {canText && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1">
                  {QUICK.map((q) => (
                    <button key={q} type="button" className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-200" onClick={() => setDraft(q)}>
                      {q}
                    </button>
                  ))}
                </div>
                {thread.replyBlock ? (
                  <p className="text-xs text-zinc-500">{thread.replyBlock}</p>
                ) : (
                  <form
                    className="flex gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send(draft);
                    }}
                  >
                    <textarea
                      value={draft}
                      maxLength={320}
                      rows={2}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Text this client"
                      aria-label="Text this client"
                      className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-sm"
                    />
                    <button type="submit" disabled={sending || !draft.trim()} className="rounded-md bg-zinc-900 px-2 py-1 text-sm text-white disabled:opacity-50">
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </form>
                )}
              </div>
            )}
            {history?.length ? (
              <details>
                <summary className="cursor-pointer text-xs text-zinc-500">Appointment notices</summary>
                <MessageHistoryList lines={history} />
              </details>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
