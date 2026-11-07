"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Notice, Textarea } from "@/components/ui";
import { SyncMsg, useSettingSync } from "@/components/brand-sync";
import { type LookupKey, cleanList, listProblem } from "@/domain/lookups";

export function LookupEditor({ id, label, hint, items, inUse, readOnly }: { id: LookupKey; label: string; hint: string; items: string[]; inUse: string[]; readOnly?: boolean }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync(`lookup.${id}`);
  const [text, setText] = useState(items.join("\n"));
  const list = cleanList(text.split("\n"));
  const problem = listProblem(list);
  const dirty = list.join("\n") !== items.join("\n");
  const dropped = inUse.filter((x) => !list.some((l) => l.toLowerCase() === x.toLowerCase()));
  return (
    <Card>
      <CardHeader title={label} subtitle={hint} />
      <div className="space-y-2 p-4 text-sm">
        <Textarea rows={Math.min(12, Math.max(4, list.length + 1))} value={text} onChange={(e) => setText(e.target.value)} disabled={readOnly} aria-label={label} />
        <p className="text-xs text-zinc-500">One per line, in the order pickers show them.</p>
        {dropped.length > 0 && <Notice>Still in use, so they stay on the menu where they are: {dropped.join(", ")}</Notice>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={readOnly || pending || !dirty || !!problem} onClick={() => saveSetting(list)}>
            Save
          </Button>
          {problem && <span className="text-amber-700">{problem}</span>}
          {!dirty && <SyncMsg msg={msg} />}
          {readOnly && <span className="text-xs text-zinc-500">Set by the brand: changes need access to every shop.</span>}
        </div>
        {dialog}
      </div>
    </Card>
  );
}
