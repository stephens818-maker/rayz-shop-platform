"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { followUpCallAction } from "./actions";

export function FollowUp({ id, done }: { id: string; done: boolean }) {
  const [note, setNote] = useState("");
  const { pending, error, run } = useAction();
  if (done)
    return (
      <button type="button" className="text-xs underline" disabled={pending} onClick={() => run(() => followUpCallAction({ id, undo: true }))}>
        Undo follow-up
      </button>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input className="w-72 py-1" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you did, e.g. rang back and booked Friday" aria-label="Follow-up note" />
      <Button size="sm" disabled={pending} onClick={() => run(() => followUpCallAction({ id, note }), () => setNote(""))}>
        Mark followed up
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
