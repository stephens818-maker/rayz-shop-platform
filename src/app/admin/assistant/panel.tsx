"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Badge, Button, buttonClass, cx } from "@/components/ui";
import type { AssistantCard, AssistantMessageView } from "@/domain/assistant";
import { askAssistantAction, assistantConversationAction, decideAssistantActionAction } from "./actions";

/** Rayz Assistant: a chat drawer on every admin page, for people whose role has it. */
export function AssistantPanel({ firstName }: { firstName: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessageView[]>([]);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || loaded) return;
    start(async () => {
      const r = await assistantConversationAction(null);
      if (!r.ok) return setError(r.error);
      setLoaded(true);
      setSuggested(r.data.suggestions);
      if (r.data.conversation) {
        setConversationId(r.data.conversation.id);
        setMessages(r.data.conversation.messages);
      }
    });
  }, [open, loaded]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, pending]);
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  const ask = (text: string) => {
    const question = text.trim();
    if (!question || pending) return;
    setError(null);
    setQ("");
    const temp: AssistantMessageView = { id: `pending-${Date.now()}`, role: "user", body: question, cards: [], at: new Date().toISOString() };
    setMessages((m) => [...m, temp]);
    start(async () => {
      const r = await askAssistantAction(conversationId, question);
      if (!r.ok) {
        setMessages((m) => m.filter((x) => x.id !== temp.id));
        setQ(question);
        return setError(r.error);
      }
      setConversationId(r.data.conversationId);
      setMessages((m) => [...m.filter((x) => x.id !== temp.id), ...r.data.messages]);
    });
  };

  const decide = (actionId: string, confirm: boolean) =>
    start(async () => {
      setError(null);
      const r = await decideAssistantActionAction(actionId, confirm);
      if (!r.ok) return setError(r.error);
      setMessages((ms) => ms.map((m) => ({ ...m, cards: m.cards.map((c) => (c.kind === "action" && c.actionId === actionId ? { ...c, status: r.data.status, links: r.data.links } : c)) })));
    });

  const fresh = () => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    box.current?.focus();
  };

  return (
    <div className="no-print">
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full bg-ink-900 px-4 py-3 text-sm font-semibold text-white shadow-lg ring-1 ring-white/10 hover:bg-ink-700"
          data-testid="assistant-open"
        >
          <Spark /> Ask Rayz
        </button>
      )}
      {open && (
        <section className="fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col rounded-t-2xl bg-white shadow-2xl ring-1 ring-zinc-200 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:h-[min(44rem,calc(100dvh-2rem))] sm:w-[26rem] sm:rounded-2xl" aria-label="Rayz Assistant" data-testid="assistant-panel">
          <header className="flex items-center justify-between gap-2 rounded-t-2xl border-b border-zinc-100 bg-ink-900 px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <Spark />
              <div>
                <div className="text-sm font-semibold">Rayz Assistant</div>
                <div className="text-[11px] text-zinc-400">Answers from the reports you can open</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={fresh} className="rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white">
                New chat
              </button>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-lg leading-none text-zinc-300 hover:bg-white/10 hover:text-white" aria-label="Close">
                ×
              </button>
            </div>
          </header>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {!messages.length && (
              <div className="space-y-3 py-2">
                <p className="text-sm text-zinc-700">
                  Hi {firstName}. Ask about sales, barbers, locations, stock, purchase orders, tips, hours or campaigns, or how to do something here. I only see what you can open yourself.
                </p>
                <div className="flex flex-wrap gap-2">
                  {suggested.map((s) => (
                    <button key={s} type="button" onClick={() => ask(s)} className="rounded-full bg-zinc-100 px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-200">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={cx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cx("max-w-[92%] space-y-2", m.role === "user" && "rounded-2xl rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white")}>
                  {m.role === "user" ? m.body : <p className="text-sm whitespace-pre-line text-zinc-800">{m.body}</p>}
                  {m.cards.map((c, i) => (
                    <CardView key={i} card={c} onDecide={decide} busy={pending} />
                  ))}
                </div>
              </div>
            ))}
            {pending && loaded && messages[messages.length - 1]?.role === "user" && <div className="text-xs text-zinc-500">Looking that up…</div>}
            <div ref={end} />
          </div>
          {error && <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}
          <form
            className="flex items-end gap-2 border-t border-zinc-100 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              ask(q);
            }}
          >
            <textarea
              ref={box}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(q);
                }
              }}
              rows={2}
              maxLength={1000}
              placeholder="Ask a question…"
              className="min-h-10 flex-1 resize-none rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-zinc-300 ring-inset focus:ring-2 focus:ring-brand-600"
              data-testid="assistant-input"
            />
            <Button type="submit" disabled={pending || !q.trim()}>
              Ask
            </Button>
          </form>
        </section>
      )}
    </div>
  );
}

function CardView({ card, onDecide, busy }: { card: AssistantCard; onDecide: (id: string, confirm: boolean) => void; busy: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200" data-testid={`assistant-card-${card.kind}`}>
      <div className="border-b border-zinc-100 bg-zinc-50 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-zinc-900">{card.title}</div>
          {card.kind === "action" && <Badge tone={card.status === "confirmed" ? "green" : card.status === "pending" ? "amber" : card.status === "failed" ? "red" : "gray"}>{STATUS[card.status]}</Badge>}
        </div>
        {card.kind === "report" && <div className="text-xs text-zinc-500">{card.subtitle}</div>}
      </div>
      <div className="space-y-2 px-3 py-2">
        {card.kind === "report" && card.stats.length > 0 && (
          <dl className="grid grid-cols-2 gap-2">
            {card.stats.map((s) => (
              <div key={s.label} className="rounded-lg bg-zinc-50 px-2 py-1.5">
                <dt className="text-[11px] text-zinc-500">{s.label}</dt>
                <dd className="text-sm font-semibold text-zinc-900">{s.value}</dd>
                {s.hint && <dd className="text-[11px] text-zinc-500">{s.hint}</dd>}
              </div>
            ))}
          </dl>
        )}
        {card.kind === "report" && card.table && card.table.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {card.table.headers.map((h, i) => (
                    <th key={i} className={cx("px-1.5 py-1 font-medium whitespace-nowrap text-zinc-500", i === 0 ? "text-left" : "text-right")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card.table.rows.map((r, j) => (
                  <tr key={j} className="border-t border-zinc-100">
                    {r.map((v, i) => (
                      <td key={i} className={cx("px-1.5 py-1 whitespace-nowrap text-zinc-800", i === 0 ? "text-left" : "text-right tabular-nums")}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {card.table.more > 0 && <div className="px-1.5 pt-1 text-[11px] text-zinc-500">and {card.table.more} more in the report</div>}
          </div>
        )}
        {card.kind === "help" && (
          <ol className="list-decimal space-y-1 pl-4 text-sm text-zinc-700">
            {card.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
        {card.kind === "action" && (
          <ul className="space-y-1 text-sm text-zinc-700">
            {card.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        {card.kind === "action" && card.status === "pending" && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" disabled={busy} onClick={() => onDecide(card.actionId, true)} data-testid="assistant-confirm">
              Confirm
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(card.actionId, false)}>
              Cancel
            </Button>
          </div>
        )}
        {card.links.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {card.links.map((l) => (
              <Link key={l.href} href={l.href} className={buttonClass("secondary", "sm")}>
                {l.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS: Record<Extract<AssistantCard, { kind: "action" }>["status"], string> = { pending: "Waiting for you", confirmed: "Done", cancelled: "Cancelled", failed: "Didn't work" };

function Spark() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-brand-500" aria-hidden>
      <path d="M10 1.5l1.9 4.8 4.8 1.9-4.8 1.9L10 15l-1.9-4.9L3.3 8.2l4.8-1.9L10 1.5zM16 13l.9 2.1L19 16l-2.1.9L16 19l-.9-2.1L13 16l2.1-.9L16 13z" />
    </svg>
  );
}
