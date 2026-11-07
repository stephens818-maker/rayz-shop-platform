"use client";

import { useState } from "react";
import { useAction } from "@/components/use-action";
import { Button, Textarea } from "@/components/ui";
import { askHelpAction } from "./help-widget-actions";

/** Read-only how-to. Shown only when HELP_WIDGET=on. It cannot change anything. */
export function HelpWidget({ firstName }: { firstName: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)]">
      {open && (
        <div className="mb-2 rounded-xl bg-white p-3 shadow-lg ring-1 ring-zinc-200">
          <div className="mb-2 text-sm font-semibold text-zinc-900">How-to for {firstName}</div>
          <p className="mb-2 text-xs text-zinc-500">Handbook only. It does not book, refund, text, or change settings.</p>
          <Textarea rows={2} value={q} maxLength={400} onChange={(e) => setQ(e.target.value)} placeholder="Ask how to do something" aria-label="Ask the handbook" />
          <Button
            size="sm"
            className="mt-2"
            disabled={pending || !q.trim()}
            onClick={() => run(() => askHelpAction(q), (data) => setAnswer(data.answer))}
          >
            Ask
          </Button>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          {answer && <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-zinc-800">{answer}</pre>}
        </div>
      )}
      <button type="button" className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow" onClick={() => setOpen((v) => !v)}>
        {open ? "Close how-to" : "How-to"}
      </button>
    </div>
  );
}
