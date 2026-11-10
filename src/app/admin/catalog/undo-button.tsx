"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { rollbackCatalogUploadAction } from "./actions";

export function UndoUploadButton({ runId, filename }: { runId: string; filename: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          confirm(`Undo "${filename}"? Every price, length, level and stock count it changed goes back, at every shop it reached. Items it added are turned off.`) &&
          start(async () => {
            const r = await rollbackCatalogUploadAction(runId);
            setMsg(r.ok ? { text: `Undone: ${r.data.restored} change${r.data.restored === 1 ? "" : "s"} put back`, ok: true } : { text: r.error, ok: false });
            if (r.ok) router.refresh();
          })
        }
      >
        Undo
      </Button>
      {msg && <span className={`max-w-64 text-xs ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</span>}
    </span>
  );
}
