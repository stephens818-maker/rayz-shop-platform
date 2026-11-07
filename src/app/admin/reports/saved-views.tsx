"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, cx } from "@/components/ui";
import type { SavedView } from "@/server/report-views-saved";
import { deleteReportViewAction, saveReportViewAction } from "./view-actions";

/** Saved views of this report: one click back to a set of dates, shops, barbers and options. */
export function SavedViews({ report, base, query, views, canShare }: { report: string; base: string; query: string; views: SavedView[]; canShare: boolean }) {
  const router = useRouter();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await saveReportViewAction({ report, name, query, shared });
      if (!r.ok) return setError(r.error);
      setNaming(false);
      setName("");
      setError(null);
      router.refresh();
    });
  return (
    <div className="no-print -mt-2 mb-4 flex flex-wrap items-center gap-1.5 text-sm" data-testid="saved-views">
      <span className="mr-1 text-xs text-zinc-500">Saved views</span>
      {views.map((v) => (
        <span key={v.id} className={cx("inline-flex items-center rounded-full ring-1", v.query === query ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300")}>
          <Link href={`${base}?${v.query}`} className="py-0.5 pl-3 pr-2" title={v.mine ? (v.shared ? "Yours, shared" : "Yours") : `Shared by ${v.owner ?? "someone"}`}>
            {v.name}
            {v.shared && <span className="ml-1 text-[10px] opacity-70">{v.mine ? "shared" : (v.owner ?? "shared")}</span>}
          </Link>
          {v.mine && (
            <button
              type="button"
              aria-label={`Remove ${v.name}`}
              className="pr-2 text-xs opacity-60 hover:opacity-100"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await deleteReportViewAction({ id: v.id, report });
                  if (!r.ok) setError(r.error);
                  else router.refresh();
                })
              }
            >
              ×
            </button>
          )}
        </span>
      ))}
      {naming ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Input className="h-7 w-44 py-0.5 text-sm" autoFocus maxLength={60} value={name} placeholder="Name this view" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          {canShare && (
            <label className="flex items-center gap-1 text-xs text-zinc-600">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share
            </label>
          )}
          <Button size="sm" variant="dark" disabled={pending || !name.trim()} onClick={save}>
            Save
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <button type="button" className="rounded-full border border-dashed border-zinc-300 px-3 py-0.5 text-zinc-600 hover:bg-white" onClick={() => setNaming(true)}>
          + Save this view
        </button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
