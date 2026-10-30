"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cx } from "@/components/ui";
import { duplicateBlastAction, pauseBlastAction, renameCampaignAction, resumeBlastAction } from "../actions";

/** Pause, resume, duplicate and rename, for a list row or the blast's own page. */
export function BlastActions({ id, name, status, mayWrite, maySend, mayManage, className }: { id: string; name: string; status: string; mayWrite: boolean; maySend: boolean; mayManage: boolean; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (f: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, after?: (data: unknown) => void) =>
    start(async () => {
      setError(null);
      const r = await f();
      if (!r.ok) return setError(r.error);
      after?.(r.data);
      router.refresh();
    });
  if (!mayManage) return null;
  const link = "text-xs underline disabled:opacity-50";
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-3", className)}>
      {maySend && status === "scheduled" && (
        <button className={link} disabled={pending} onClick={() => run(() => pauseBlastAction(id))}>
          Pause
        </button>
      )}
      {maySend && status === "paused" && (
        <button className={link} disabled={pending} onClick={() => run(() => resumeBlastAction(id))}>
          Resume
        </button>
      )}
      {mayWrite && (
        <button
          className={link}
          disabled={pending}
          onClick={() => {
            const next = prompt("New name (only staff see it)", name);
            if (next && next.trim() && next.trim() !== name) run(() => renameCampaignAction(id, next.trim()));
          }}
        >
          Rename
        </button>
      )}
      {mayWrite && (
        <button className={link} disabled={pending} onClick={() => run(() => duplicateBlastAction(id), (d) => router.push(`/admin/campaign-center/blasts/${(d as { id: string }).id}`))}>
          Duplicate
        </button>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
