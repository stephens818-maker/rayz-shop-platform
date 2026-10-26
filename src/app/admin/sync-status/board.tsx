"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Diff, StatusPill } from "@/components/brand-sync";
import { Button, Card, Empty, cx } from "@/components/ui";
import { ACTION_LABEL, BULK_HINT, BULK_LABEL, type BulkAction, type ShownStatus, STATUS_LABEL, type SyncArea } from "@/domain/brand-sync";
import type { BatchDetail, ControlRow, HistoryBatch, Matrix, MatrixRow } from "@/server/brand-sync/engine";
import { batchDetailAction, bulkSyncAction, cancelScheduledAction, rollbackSyncAction, runScheduledNowAction, setSyncControlAction } from "./actions";

type Tab = "matrix" | "history" | "controls";
type StatusFilter = "all" | "attention" | ShownStatus;

const CELL_TONE: Record<ShownStatus, string> = {
  in_sync: "text-zinc-600",
  overridden: "bg-violet-50 text-violet-800",
  out_of_sync: "bg-amber-50 text-amber-900",
  pending: "bg-sky-50 text-sky-800",
};
const DOT: Record<ShownStatus, string> = { in_sync: "bg-emerald-500", overridden: "bg-violet-500", out_of_sync: "bg-amber-500", pending: "bg-sky-500" };

const at = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const cellId = (key: string, shopId: string) => `${key}|${shopId}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function SyncStatusBoard({
  matrix,
  history,
  controls,
  areas,
  mayType,
  initialTab,
  initialArea,
}: {
  matrix: Matrix;
  history: HistoryBatch[];
  controls: ControlRow[];
  areas: { id: SyncArea; label: string }[];
  mayType: Record<string, boolean>;
  initialTab: Tab;
  initialArea: string | null;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const scheduled = history.filter((h) => h.status === "scheduled").length;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "matrix", label: "Matrix" },
    { id: "history", label: "History", count: scheduled || undefined },
    { id: "controls", label: "Shop edits" },
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["in_sync", "overridden", "out_of_sync", "pending"] as const).map((s) => (
          <div key={s} className="rounded-xl bg-white px-4 py-3 ring-1 ring-zinc-200" data-testid={`total-${s}`}>
            <StatusPill status={s} />
            <div className="tabular mt-1 text-2xl font-semibold tracking-tight text-zinc-900">{matrix.totals[s]}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 border-b border-zinc-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium transition", tab === t.id ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800")}
          >
            {t.label}
            {t.count ? <span className="ml-1.5 rounded-full bg-sky-100 px-1.5 text-[11px] text-sky-800">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {tab === "matrix" && <MatrixView matrix={matrix} areas={areas} mayType={mayType} initialArea={initialArea} />}
      {tab === "history" && <HistoryView history={history} canAct={Object.values(mayType).some(Boolean)} />}
      {tab === "controls" && <ControlsView controls={controls} mayType={mayType} />}
    </>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("h-7 whitespace-nowrap rounded-full px-3 text-xs font-medium ring-1 ring-inset transition", on ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-600 ring-zinc-200 hover:ring-zinc-300")}
    >
      {children}
    </button>
  );
}

function MatrixView({ matrix, areas, mayType, initialArea }: { matrix: Matrix; areas: { id: SyncArea; label: string }[]; mayType: Record<string, boolean>; initialArea: string | null }) {
  const router = useRouter();
  const [area, setArea] = useState<string | null>(initialArea);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<{ text: string; batchId: string | null; tone: "ok" | "error" } | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return matrix.rows.filter((r) => {
      if (area && r.area !== area) return false;
      if (needle && !r.label.toLowerCase().includes(needle) && !(r.hint ?? "").toLowerCase().includes(needle)) return false;
      if (status === "all") return true;
      if (status === "attention") return r.counts.overridden + r.counts.out_of_sync + r.counts.pending > 0;
      return r.counts[status] > 0;
    });
  }, [matrix.rows, area, q, status]);

  const groups = useMemo(() => {
    const m = new Map<SyncArea, MatrixRow[]>();
    for (const r of rows) m.set(r.area, [...(m.get(r.area) ?? []), r]);
    return areas.filter((a) => m.has(a.id)).map((a) => ({ ...a, rows: m.get(a.id)! }));
  }, [rows, areas]);

  const selectable = (r: MatrixRow, i: number) => !!r.cells[i] && mayType[r.type];
  const toggleCells = (ids: string[]) =>
    setSel((s) => {
      const next = new Set(s);
      const allOn = ids.every((id) => next.has(id));
      ids.forEach((id) => (allOn ? next.delete(id) : next.add(id)));
      return next;
    });
  const rowIds = (r: MatrixRow) => matrix.shops.flatMap((s, i) => (selectable(r, i) ? [cellId(r.key, s.id)] : []));
  const colIds = (i: number) => rows.flatMap((r) => (selectable(r, i) ? [cellId(r.key, matrix.shops[i].id)] : []));
  const attentionIds = () => rows.flatMap((r) => matrix.shops.flatMap((s, i) => (selectable(r, i) && r.cells[i]!.s !== "in_sync" && r.cells[i]!.s !== "pending" ? [cellId(r.key, s.id)] : [])));

  const selCounts = useMemo(() => {
    const c = { overridden: 0, other: 0 };
    for (const id of sel) {
      const [key, shopId] = [id.slice(0, id.lastIndexOf("|")), id.slice(id.lastIndexOf("|") + 1)];
      const r = matrix.rows.find((x) => x.key === key);
      const i = matrix.shops.findIndex((s) => s.id === shopId);
      if (r?.cells[i]?.s === "overridden" || r?.cells[i]?.o) c.overridden++;
      else c.other++;
    }
    return c;
  }, [sel, matrix]);

  const bulk = (action: BulkAction) =>
    start(async () => {
      if (action === "reset" && selCounts.overridden && !confirm(`Reset ${plural(selCounts.overridden, "shop value")} to the brand? Those shops lose their own value. You can undo this from History.`)) return;
      const cells = [...sel].map((id) => ({ key: id.slice(0, id.lastIndexOf("|")), shopId: id.slice(id.lastIndexOf("|") + 1) }));
      const r = await bulkSyncAction(action, cells);
      if (!r.ok) return setFlash({ text: r.error, batchId: null, tone: "error" });
      setSel(new Set());
      setFlash({ text: r.data.changed ? `${BULK_LABEL[action]}: ${plural(r.data.changed, "cell")} updated` : "Nothing to change. Those cells already match.", batchId: r.data.batchId, tone: "ok" });
      router.refresh();
    });
  const undo = (batchId: string) =>
    start(async () => {
      const r = await rollbackSyncAction(batchId);
      setFlash(r.ok ? { text: `Undone: ${plural(r.data.changed, "cell")} restored`, batchId: null, tone: "ok" } : { text: r.error, batchId: null, tone: "error" });
      router.refresh();
    });

  if (!matrix.rows.length) return <Empty title="Nothing is brand-controlled yet">Add services, products or brand defaults and they show here.</Empty>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip on={!area} onClick={() => setArea(null)}>
          All areas
        </Chip>
        {areas.map((a) => (
          <Chip key={a.id} on={area === a.id} onClick={() => setArea(area === a.id ? null : a.id)}>
            {a.label}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a setting"
          className="h-8 w-56 rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-zinc-200 placeholder:text-zinc-400 focus:ring-2 focus:ring-brand-600"
        />
        <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs">
          {(["all", "attention", "overridden", "out_of_sync", "pending"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cx("rounded-md px-2.5 py-1 font-medium", status === s ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-500 hover:text-zinc-800")}
            >
              {s === "all" ? "Everything" : s === "attention" ? "Needs a look" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <button type="button" className="text-xs font-medium text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900" onClick={() => setSel(new Set(attentionIds()))}>
          Select everything that differs
        </button>
        <span className="ml-auto text-xs text-zinc-500">
          {plural(rows.length, "setting")} · {plural(matrix.shops.length, "shop")}
        </span>
      </div>

      {flash && (
        <div className={cx("flex items-center gap-3 rounded-lg px-3 py-2 text-sm ring-1 ring-inset", flash.tone === "ok" ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-red-50 text-red-900 ring-red-200")} role="status">
          <span className="flex-1">{flash.text}</span>
          {flash.batchId && (
            <button type="button" className="font-medium underline underline-offset-2" disabled={pending} onClick={() => undo(flash.batchId!)}>
              Undo
            </button>
          )}
          <button type="button" className="text-xs opacity-60 hover:opacity-100" onClick={() => setFlash(null)}>
            Dismiss
          </button>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="max-h-[70vh] overflow-auto" data-testid="sync-matrix">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-20">
              <tr>
                <th className="sticky left-0 z-30 min-w-64 border-b border-r border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">Setting</th>
                <th className="min-w-28 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">Brand</th>
                {matrix.shops.map((s, i) => (
                  <th key={s.id} className="min-w-28 border-b border-zinc-200 bg-zinc-50 px-2 py-2 text-left">
                    <button type="button" title={`Select ${s.name}'s column`} onClick={() => toggleCells(colIds(i))} className="max-w-32 truncate text-xs font-semibold text-zinc-700 hover:text-zinc-950">
                      {s.name}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g.id} label={g.label} rows={g.rows} shops={matrix.shops} sel={sel} selectable={selectable} toggleCells={toggleCells} rowIds={rowIds} />
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="px-4 py-10 text-center text-sm text-zinc-500">No settings match</div>}
        </div>
      </Card>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        {(["in_sync", "overridden", "out_of_sync", "pending"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={cx("h-1.5 w-1.5 rounded-full", DOT[s])} />
            <b className="font-medium text-zinc-700">{STATUS_LABEL[s]}</b>
            {s === "in_sync" ? "follows the brand" : s === "overridden" ? "has its own value" : s === "out_of_sync" ? "follows the brand but wasn't synced" : "a scheduled sync will change it"}
          </span>
        ))}
      </div>

      {sel.size > 0 && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-fit flex-wrap items-center gap-2 rounded-xl bg-zinc-900 px-3 py-2 text-sm text-white shadow-2xl ring-1 ring-black/10" data-testid="bulk-bar">
          <span className="px-1 font-medium">{plural(sel.size, "cell")} selected</span>
          {selCounts.overridden > 0 && <span className="text-xs text-violet-200">{selCounts.overridden} overridden</span>}
          <span className="mx-1 h-4 w-px bg-white/20" />
          <button type="button" title={BULK_HINT.push} disabled={pending} onClick={() => bulk("push")} className="rounded-md px-2.5 py-1 font-medium hover:bg-white/10 disabled:opacity-50">
            {BULK_LABEL.push}
          </button>
          <button type="button" title={BULK_HINT.reset} disabled={pending} onClick={() => bulk("reset")} className="rounded-md px-2.5 py-1 font-medium hover:bg-white/10 disabled:opacity-50">
            {BULK_LABEL.reset}
          </button>
          <button type="button" disabled={pending} onClick={() => setSel(new Set())} className="rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function GroupRows({
  label,
  rows,
  shops,
  sel,
  selectable,
  toggleCells,
  rowIds,
}: {
  label: string;
  rows: MatrixRow[];
  shops: Matrix["shops"];
  sel: Set<string>;
  selectable: (r: MatrixRow, i: number) => boolean;
  toggleCells: (ids: string[]) => void;
  rowIds: (r: MatrixRow) => string[];
}) {
  return (
    <>
      <tr>
        <td colSpan={shops.length + 2} className="sticky left-0 border-b border-zinc-100 bg-white px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          {label}
        </td>
      </tr>
      {rows.map((r) => {
        const ids = rowIds(r);
        const rowOn = ids.length > 0 && ids.every((id) => sel.has(id));
        return (
          <tr key={r.key} className="group" data-testid={`row-${r.key}`}>
            <td className="sticky left-0 z-10 border-b border-r border-zinc-100 bg-white px-3 py-1.5 group-hover:bg-zinc-50">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={rowOn} disabled={!ids.length} onChange={() => toggleCells(ids)} aria-label={`Select ${r.label} at every shop`} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-zinc-900">{r.label}</span>
                  {r.hint && <span className="block truncate text-[11px] text-zinc-500">{r.hint}</span>}
                </span>
              </label>
            </td>
            <td className="border-b border-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 group-hover:bg-zinc-50">
              <span className="block max-w-40 truncate" title={r.brand}>
                {r.brand}
              </span>
            </td>
            {shops.map((s, i) => {
              const c = r.cells[i];
              if (!c) return <td key={s.id} className="border-b border-zinc-100 px-2 py-1.5 text-xs text-zinc-300 group-hover:bg-zinc-50">—</td>;
              const id = cellId(r.key, s.id);
              const on = sel.has(id);
              const can = selectable(r, i);
              return (
                <td key={s.id} className="border-b border-zinc-100 px-1 py-1 group-hover:bg-zinc-50">
                  <button
                    type="button"
                    disabled={!can}
                    onClick={() => toggleCells([id])}
                    title={`${s.name}: ${STATUS_LABEL[c.s]}${c.o ? " (has its own value)" : ""} · ${c.t}`}
                    data-status={c.s}
                    className={cx(
                      "flex w-full max-w-36 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition",
                      CELL_TONE[c.s],
                      on ? "ring-2 ring-brand-600 ring-offset-1" : can && "hover:ring-1 hover:ring-zinc-300",
                    )}
                  >
                    <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[c.s])} />
                    <span className="truncate tabular">{c.s === "in_sync" ? "In sync" : c.t}</span>
                  </button>
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}

const BATCH_STATUS: Record<string, { label: string; cls: string }> = {
  applied: { label: "Applied", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  scheduled: { label: "Scheduled", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  rolled_back: { label: "Undone", cls: "bg-zinc-100 text-zinc-600 ring-zinc-200" },
  cancelled: { label: "Cancelled", cls: "bg-zinc-100 text-zinc-600 ring-zinc-200" },
  failed: { label: "Failed", cls: "bg-red-50 text-red-800 ring-red-200" },
};
const KIND_LABEL: Record<string, string> = { apply: "Brand change", push: "Bulk push", reset: "Bulk reset", rollback: "Undo" };

function HistoryView({ history, canAct }: { history: HistoryBatch[]; canAct: boolean }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      router.refresh();
    });

  if (!history.length) return <Empty title="No syncs yet">Each brand change, bulk push, reset and undo shows here, with every shop&apos;s before and after.</Empty>;
  const open = history.find((h) => h.id === openId) ?? null;
  return (
    <div className="space-y-3">
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-inset ring-red-200">
          {error}
        </div>
      )}
      <Card className="divide-y divide-zinc-100" data-testid="sync-history">
        {history.map((h) => {
          const st = BATCH_STATUS[h.status] ?? BATCH_STATUS.applied;
          return (
            <div key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-zinc-50/70">
              <button type="button" onClick={() => setOpenId(h.id)} className="min-w-0 flex-1 text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-900">{h.label}</span>
                  <span className={cx("rounded-full px-2 py-px text-[11px] font-medium ring-1 ring-inset", st.cls)}>{h.status === "scheduled" && h.runAt ? `Scheduled · ${at(h.runAt)}` : st.label}</span>
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {KIND_LABEL[h.kind]} · {h.scopeText}
                  {h.status !== "scheduled" && ` · ${plural(h.changed, "change")}`} · {h.by} · {at(h.at)}
                  {h.rolledBackAt && ` · undone by ${h.rolledBackBy} ${at(h.rolledBackAt)}`}
                  {h.error && <span className="text-red-700"> · {h.error}</span>}
                </div>
              </button>
              {canAct && (
                <div className="flex items-center gap-1.5">
                  {h.status === "scheduled" && (
                    <>
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => runScheduledNowAction(h.id))}>
                        Run now
                      </Button>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Cancel this scheduled sync? Nothing changes at the shops.") && act(() => cancelScheduledAction(h.id))}>
                        Cancel
                      </Button>
                    </>
                  )}
                  {h.status === "applied" && h.kind !== "rollback" && (
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => confirm(`Undo "${h.label}"? The brand and every shop it changed go back to how they were.`) && act(() => rollbackSyncAction(h.id))}>
                      Undo
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Card>
      {open && <BatchDrawer key={open.id} batch={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function BatchDrawer({ batch, onClose }: { batch: HistoryBatch; onClose: () => void }) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void batchDetailAction(batch.id).then((r) => live && (r.ok ? setDetail(r.data) : setError(r.error)));
    return () => {
      live = false;
    };
  }, [batch.id]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-950/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl ring-1 ring-zinc-900/10" role="dialog" aria-label={batch.label} data-testid="batch-drawer">
        <header className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{KIND_LABEL[batch.kind]}</div>
            <h2 className="mt-0.5 text-base font-semibold text-zinc-900">{batch.label}</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {batch.by} · {at(batch.at)} · {batch.scopeText}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100">
            Close
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {error && <p className="text-sm text-red-700">{error}</p>}
          {!detail && !error && <div className="h-24 animate-pulse rounded-lg bg-zinc-100" />}
          {detail?.plan && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Planned</h3>
              <p className="mt-1 text-sm text-zinc-700">
                {detail.plan.keys.join(", ")} → {detail.plan.scope === "brand_only" ? "brand only" : detail.plan.shops.join(", ") || "no shops"}
              </p>
            </section>
          )}
          {detail && detail.brand.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Brand</h3>
              <ul className="mt-1.5 space-y-1">
                {detail.brand.map((b) => (
                  <li key={b.key} className="rounded-lg bg-zinc-50 px-3 py-2">
                    <div className="text-sm font-medium text-zinc-900">
                      {b.label}
                      {b.created && <span className="ml-2 text-xs font-normal text-zinc-500">new</span>}
                    </div>
                    <Diff changes={b.changes} max={8} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Shops · {detail.shops.length}</h3>
              {!detail.shops.length && <p className="mt-1 text-sm text-zinc-500">No shop changed.</p>}
              <ul className="mt-1.5 divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-100">
                {detail.shops.map((s) => (
                  <li key={s.shopId} className="px-3 py-2">
                    <div className="text-sm font-medium text-zinc-900">{s.name}</div>
                    <ul className="mt-1 space-y-1">
                      {s.settings.map((x) => (
                        <li key={x.key} className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-xs text-zinc-700">{x.label}</span>
                          <span className="rounded bg-zinc-100 px-1.5 text-[11px] text-zinc-600">{ACTION_LABEL[x.action]}</span>
                          {x.action === "keep" || x.action === "freeze" ? <span className="text-xs text-zinc-500">stays {x.changes[0]?.from ?? "as it was"}</span> : <Diff changes={x.changes} max={4} />}
                          {x.modeFrom !== x.modeTo && <span className="text-[11px] text-zinc-500">{x.modeTo === "override" ? "now its own" : "now follows the brand"}</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function ControlsView({ controls, mayType }: { controls: ControlRow[]; mayType: Record<string, boolean> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-zinc-600">
        Brand-controlled settings are set by the brand. Shop managers can only change their own shop&apos;s value where you allow it. A shop that does shows as overridden, and a sync keeps its value unless you replace it. New
        shops always start from the brand.
      </p>
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-inset ring-red-200">
          {error}
        </div>
      )}
      <Card className="divide-y divide-zinc-100" data-testid="sync-controls">
        {controls.map((c) => (
          <label
            key={c.type}
            className="flex items-center justify-between gap-4 px-4 py-3"
            data-testid={`control-${c.type}`}
            title={mayType[c.type] ? undefined : "Only someone who can change this setting for the brand can switch it."}
          >
            <span>
              <span className="block text-sm font-medium text-zinc-900">{c.noun}</span>
              <span className="block text-xs text-zinc-500">{c.areaLabel}</span>
            </span>
            <span className="flex items-center gap-3">
              <span className={cx("text-xs", c.shopsCanEdit ? "text-emerald-700" : "text-zinc-500")}>{c.shopsCanEdit ? "Shop managers can change it" : "Brand only"}</span>
              <input
                type="checkbox"
                role="switch"
                className="h-5 w-5 accent-brand-600"
                checked={c.shopsCanEdit}
                disabled={pending || !mayType[c.type]}
                onChange={(e) =>
                  start(async () => {
                    setError(null);
                    const r = await setSyncControlAction(c.type, e.target.checked);
                    if (!r.ok) setError(r.error);
                    router.refresh();
                  })
                }
              />
            </span>
          </label>
        ))}
      </Card>
    </div>
  );
}
