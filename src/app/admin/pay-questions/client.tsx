"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Field, Notice, Select, Textarea } from "@/components/ui";
import { PAY_QUESTION_TOPICS, PAY_QUESTION_TOPIC_LABEL } from "@/domain/staff-privacy";
import { answerPayQuestionAction, askPayQuestionAction, escalatePayQuestionAction, resolvePayQuestionAction } from "./actions";
import { formatDateTime } from "@/lib/time";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<Result<T>>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });
  return { pending, error, run };
}

export interface QuestionView {
  id: string;
  staff: string | null;
  shop: string | null;
  periodStart: string | null;
  topicLabel: string;
  detail: string;
  status: "open" | "answered" | "resolved";
  level: "manager" | "owner";
  dueAt: string;
  overdue: boolean;
  history: { at: string; kind: string; byLabel: string; text: string | null }[];
  canEscalate: boolean;
  canAnswer: boolean;
}

const when = (iso: string) => formatDateTime(iso, "MMM d", ", ");
const KIND_LABEL: Record<string, string> = { asked: "Asked", answered: "Answered", escalated: "Sent to the owners", resolved: "Closed", reminded: "Owners reminded" };

export function AskForm({ shops, periods }: { shops: { id: string; name: string }[]; periods: { start: string; label: string }[] }) {
  const { pending, error, run } = useRun();
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState(periods[0]?.start ?? "");
  const [topic, setTopic] = useState<string>("hours");
  const [detail, setDetail] = useState("");
  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => askPayQuestionAction({ shopId, periodStart: periodStart || null, topic, detail }), () => setDetail(""));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Shop">
          <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Pay period">
          <Select value={periodStart} onChange={(e) => setPeriodStart(e.target.value)}>
            {periods.map((p) => (
              <option key={p.start} value={p.start}>
                {p.label}
              </option>
            ))}
            <option value="">Not about one period</option>
          </Select>
        </Field>
        <Field label="About">
          <Select value={topic} onChange={(e) => setTopic(e.target.value)}>
            {PAY_QUESTION_TOPICS.map((t) => (
              <option key={t} value={t}>
                {PAY_QUESTION_TOPIC_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="What looks wrong">
        <Textarea rows={3} value={detail} maxLength={2000} onChange={(e) => setDetail(e.target.value)} />
      </Field>
      {error && <Notice tone="red">{error}</Notice>}
      <Button type="submit" disabled={pending || !detail.trim() || !shopId}>
        Send to my managers
      </Button>
    </form>
  );
}

export function QuestionCard({ q, mine }: { q: QuestionView; mine: boolean }) {
  const { pending, error, run } = useRun();
  const [text, setText] = useState("");
  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{q.topicLabel}</span>
        {!mine && q.staff && <span>{q.staff}</span>}
        <span className="text-zinc-500">
          {q.shop}
          {q.periodStart ? ` · period from ${q.periodStart}` : ""}
        </span>
        <Badge tone={q.status === "resolved" ? "gray" : q.status === "answered" ? "green" : q.overdue ? "red" : "amber"}>{q.status === "open" ? (q.overdue ? "overdue" : `answer by ${when(q.dueAt)}`) : q.status === "answered" ? "answered" : "closed"}</Badge>
        {q.level === "owner" && <Badge tone="blue">with the owners</Badge>}
      </div>
      <ol className="space-y-1 border-l-2 border-zinc-200 pl-3">
        {q.history.map((h, i) => (
          <li key={i}>
            <span className="text-zinc-500">
              {KIND_LABEL[h.kind] ?? h.kind} · {h.byLabel} · {when(h.at)}
            </span>
            {h.text && <p className="whitespace-pre-wrap">{h.text}</p>}
          </li>
        ))}
      </ol>
      {error && <Notice tone="red">{error}</Notice>}
      {mine && q.status !== "resolved" && (
        <div className="flex flex-wrap items-end gap-2">
          {q.canEscalate && (
            <>
              <Textarea aria-label="Why it isn't settled" rows={1} className="max-w-md" placeholder="Why it isn't settled (optional)" value={text} onChange={(e) => setText(e.target.value)} />
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => escalatePayQuestionAction(q.id, text), () => setText(""))}>
                Send to the owners
              </Button>
            </>
          )}
          {q.status === "answered" && (
            <Button size="sm" disabled={pending} onClick={() => run(() => resolvePayQuestionAction(q.id))}>
              That settles it
            </Button>
          )}
        </div>
      )}
      {!mine && q.canAnswer && (
        <div className="flex flex-wrap items-end gap-2">
          <Textarea aria-label="Answer" rows={2} className="max-w-xl" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" disabled={pending || !text.trim()} onClick={() => run(() => answerPayQuestionAction(q.id, text), () => setText(""))}>
            Answer
          </Button>
        </div>
      )}
    </li>
  );
}
