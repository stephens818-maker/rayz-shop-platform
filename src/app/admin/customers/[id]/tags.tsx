"use client";

import { useState } from "react";
import { Button, Input, Suggestions } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { setClientTagsAction } from "../actions";

/** The client's tags, for marketing segments. */
export function ClientTags({ customerId, tags, known, canEdit }: { customerId: string; tags: string[]; known: string[]; canEdit: boolean }) {
  const { pending, error, run } = useAction();
  const [list, setList] = useState(tags);
  const [text, setText] = useState("");
  const save = (next: string[]) => run(() => setClientTagsAction(customerId, next), () => setList(next));
  return (
    <div className="space-y-2 p-4" data-testid="client-tags">
      <div className="flex flex-wrap gap-1.5">
        {list.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-800">
            {t}
            {canEdit && (
              <button type="button" disabled={pending} className="text-zinc-400 hover:text-zinc-800" aria-label={`Remove ${t}`} onClick={() => save(list.filter((x) => x !== t))}>
                ×
              </button>
            )}
          </span>
        ))}
        {!list.length && <span className="text-sm text-zinc-500">No tags.</span>}
      </div>
      {canEdit && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t || list.includes(t)) return setText("");
            save([...list, t]);
            setText("");
          }}
        >
          <Input list="client-tag-options" placeholder="Add a tag, e.g. VIP" value={text} maxLength={40} onChange={(e) => setText(e.target.value)} />
          <Suggestions id="client-tag-options" items={known.filter((k) => !list.includes(k))} />
          <Button type="submit" variant="secondary" disabled={pending || !text.trim()}>
            Add
          </Button>
        </form>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
