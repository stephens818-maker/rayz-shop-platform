"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { closeHelpRequestAction } from "./actions";

export function CloseRequest({ id, candidates }: { id: string; candidates: { id: string; label: string }[] }) {
  const { pending, error, run } = useAction();
  const [note, setNote] = useState("");
  const close = (status: "resolved" | "dismissed", confirmCustomerId: string | null = null) => run(() => closeHelpRequestAction(id, { status, resolution: note || null, confirmCustomerId }));
  return (
    <div className="space-y-2" data-testid={`help-${id}`}>
      <Input value={note} maxLength={500} placeholder="What you did (optional)" onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        {candidates.map((c) => (
          <Button key={c.id} size="sm" disabled={pending} onClick={() => close("resolved", c.id)}>
            It&apos;s {c.label}: confirm
          </Button>
        ))}
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => close("resolved")}>
          Done
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => close("dismissed")}>
          Dismiss
        </Button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
