"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Notice, Textarea } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { type LookupKey, cleanList, listProblem } from "@/domain/lookups";
import { saveLookupAction } from "./actions";

export function LookupEditor({ id, label, hint, items, inUse }: { id: LookupKey; label: string; hint: string; items: string[]; inUse: string[] }) {
  const { pending, error, run } = useAction();
  const [text, setText] = useState(items.join("\n"));
  const [ok, setOk] = useState(false);
  const list = cleanList(text.split("\n"));
  const problem = listProblem(list);
  const dirty = list.join("\n") !== items.join("\n");
  const dropped = inUse.filter((x) => !list.some((l) => l.toLowerCase() === x.toLowerCase()));
  return (
    <Card>
      <CardHeader title={label} subtitle={hint} />
      <div className="space-y-2 p-4 text-sm">
        <Textarea rows={Math.min(12, Math.max(4, list.length + 1))} value={text} onChange={(e) => (setOk(false), setText(e.target.value))} aria-label={label} />
        <p className="text-xs text-zinc-500">One per line, in the order pickers show them.</p>
        {dropped.length > 0 && <Notice>Still in use, so they stay on the menu where they are: {dropped.join(", ")}</Notice>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={pending || !dirty || !!problem} onClick={() => run(() => saveLookupAction(id, list), (d) => (setText(d.join("\n")), setOk(true)))}>
            Save
          </Button>
          {problem && <span className="text-amber-700">{problem}</span>}
          {ok && !dirty && <span className="text-emerald-700">Saved</span>}
        </div>
        {error && <Notice tone="red">{error}</Notice>}
      </div>
    </Card>
  );
}
