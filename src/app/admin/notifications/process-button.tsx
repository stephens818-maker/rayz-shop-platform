"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { processNowAction } from "./actions";

export function ProcessNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      {msg && <span className="text-sm text-zinc-600">{msg}</span>}
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await processNowAction();
            setMsg(r.ok ? `Sent ${r.data.sent} · suppressed ${r.data.suppressed} · failed ${r.data.failed}` : r.error);
            router.refresh();
          })
        }
      >
        {pending ? "Processing…" : "Process due now"}
      </Button>
    </div>
  );
}
