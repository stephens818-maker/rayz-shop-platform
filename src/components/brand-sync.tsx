"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CellStatus, type FieldChange, type OverrideChoice, SCOPE_HINT, SCOPE_LABEL, STATUS_LABEL, type SyncScope, type SyncType } from "@/domain/brand-sync";
import type { CommitResult, Preview, PreviewKey } from "@/server/brand-sync/engine";
import { commitBrandSyncAction, previewBrandSyncAction } from "@/app/admin/sync-status/actions";
import { Button, cx } from "./ui";

export interface BrandChange {
  type: SyncType;
  item: string;
  value: unknown;
}

export interface OpenSync {
  changes: BrandChange[];
  /** Shown in the dialog title and the history, e.g. "Skin fade price". Defaults to the setting's name. */
  label?: string;
  onDone?: (r: CommitResult) => void;
}

const STATUS_DOT: Record<CellStatus, string> = { in_sync: "bg-emerald-500", overridden: "bg-violet-500", out_of_sync: "bg-amber-500" };
const STATUS_TEXT: Record<CellStatus, string> = { in_sync: "text-emerald-700", overridden: "text-violet-700", out_of_sync: "text-amber-700" };

export function StatusPill({ status, className }: { status: CellStatus | "pending"; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium", status === "pending" ? "text-sky-700" : STATUS_TEXT[status], className)}>
      <span className={cx("h-1.5 w-1.5 rounded-full", status === "pending" ? "bg-sky-500" : STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Diff({ changes, max = 3, muted }: { changes: FieldChange[]; max?: number; muted?: boolean }) {
  if (!changes.length) return <span className="text-xs text-zinc-400">No change</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {changes.slice(0, max).map((c) => (
        <span key={c.field} className="inline-flex items-baseline gap-1">
          <span className="text-zinc-500">{c.field}</span>
          <span className={cx("tabular", muted ? "text-zinc-400" : "text-zinc-400 line-through decoration-zinc-300")}>{c.from}</span>
          {!muted && (
            <>
              <span className="text-zinc-300">→</span>
              <span className="tabular font-medium text-zinc-900">{c.to}</span>
            </>
          )}
        </span>
      ))}
      {changes.length > max && <span className="text-zinc-400">+{changes.length - max} more</span>}
    </span>
  );
}

/** Tomorrow at 9am, local, as a datetime-local value. */
function defaultRunAt() {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(9, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const whenText = (local: string) => {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

interface ShopLine {
  id: string;
  name: string;
  cells: { key: PreviewKey; status: CellStatus; changes: FieldChange[]; current: string }[];
  overridden: boolean;
  status: CellStatus;
}

function shopLines(p: Preview): ShopLine[] {
  const out: ShopLine[] = [];
  for (const s of p.shops) {
    const cells = p.keys.flatMap((k) => {
      const c = k.cells.find((x) => x.shopId === s.id);
      return c ? [{ key: k, status: c.status, changes: c.changes, current: c.currentShort }] : [];
    });
    if (!cells.length) continue;
    const overridden = cells.some((c) => c.status === "overridden");
    out.push({ id: s.id, name: s.name, cells, overridden, status: overridden ? "overridden" : cells.some((c) => c.status === "out_of_sync") ? "out_of_sync" : "in_sync" });
  }
  return out;
}

/**
 * The brand change scope for any brand editor: `open({ changes })` previews the change at every
 * shop, and the admin picks all shops, some, or the brand only; keeps or replaces shops' own
 * values; and applies now or at a set time. Render `dialog` once in the editor.
 */
export function useBrandSync() {
  const [req, setReq] = useState<(OpenSync & { preview: Preview }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const open = useCallback(
    async (o: OpenSync) => {
      setError(null);
      setBusy(true);
      const r = await previewBrandSyncAction(o.changes);
      setBusy(false);
      if (!r.ok) return setError(r.error);
      const shopsAffected = r.data.keys.some((k) => !k.brandOnly && k.cells.length);
      if (!shopsAffected) {
        setBusy(true);
        const c = await commitBrandSyncAction({ changes: o.changes, scope: "brand_only", shopIds: [], overrides: {}, label: o.label });
        setBusy(false);
        if (!c.ok) return setError(c.error);
        o.onDone?.(c.data);
        router.refresh();
        return;
      }
      setReq({ ...o, preview: r.data });
    },
    [router],
  );

  const dialog = req ? (
    <BrandSyncDialog
      req={req}
      onClose={() => setReq(null)}
      onDone={(r) => {
        const done = req.onDone;
        setReq(null);
        done?.(r);
        router.refresh();
      }}
    />
  ) : null;

  return { open, dialog, error, setError, pending: busy || !!req };
}

function Segmented<T extends string>({ value, onChange, options, size = "md" }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode; hint?: string }[]; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg bg-zinc-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={cx(
            "rounded-md font-medium transition",
            size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1.5 text-sm",
            value === o.id ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-500 hover:text-zinc-800",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BrandSyncDialog({ req, onClose, onDone }: { req: OpenSync & { preview: Preview }; onClose: () => void; onDone: (r: CommitResult) => void }) {
  const p = req.preview;
  const lines = useMemo(() => shopLines(p), [p]);
  const [scope, setScope] = useState<SyncScope>("all");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(lines.map((l) => l.id)));
  const [overrides, setOverrides] = useState<Record<string, OverrideChoice>>({});
  const [when, setWhen] = useState<"now" | "later">("now");
  const [runAt, setRunAt] = useState(defaultRunAt);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const targeted = (id: string) => scope === "all" || (scope === "selected" && picked.has(id));
  const changing = lines.filter((l) => targeted(l.id) && (!l.overridden || overrides[l.id] === "replace") && l.cells.some((c) => c.changes.length));
  const keeping = lines.filter((l) => targeted(l.id) && l.overridden && overrides[l.id] !== "replace");
  const holding = lines.filter((l) => !targeted(l.id));
  const overriddenCount = lines.filter((l) => l.overridden).length;
  const shown = query.trim() ? lines.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase())) : lines;
  const pending = p.keys.flatMap((k) => k.pending);
  const title = req.label ?? (p.keys.length === 1 ? p.keys[0].label : `${p.keys.length} brand settings`);

  const submit = useCallback(async () => {
    if (scope === "selected" && !picked.size) return setError(`Tick at least one shop, or choose "${SCOPE_LABEL.brand_only}"`);
    setSaving(true);
    setError(null);
    const r = await commitBrandSyncAction({
      changes: req.changes,
      scope,
      shopIds: scope === "selected" ? [...picked] : [],
      overrides,
      runAt: when === "later" && scope !== "brand_only" ? new Date(runAt).toISOString() : null,
      label: req.label,
    });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    onDone(r.data);
  }, [scope, picked, overrides, when, runAt, req, onDone]);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !saving) void submit();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, submit, saving]);

  const setAll = (ids: string[]) => {
    setScope("selected");
    setPicked(new Set(ids));
  };
  const toggle = (id: string) => {
    const next = new Set(scope === "all" ? lines.map((l) => l.id) : scope === "brand_only" ? [] : picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setScope(next.size === lines.length ? "all" : next.size ? "selected" : "brand_only");
    setPicked(next);
  };

  const cta =
    scope === "brand_only"
      ? "Save to brand only"
      : when === "later"
        ? `Schedule for ${whenText(runAt)}`
        : `Apply to ${changing.length} shop${changing.length === 1 ? "" : "s"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="brand-sync-title"
        data-testid="brand-sync-dialog"
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl ring-1 ring-zinc-900/10 outline-none sm:rounded-2xl"
      >
        <header className="border-b border-zinc-100 px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Brand change · {[...new Set(p.keys.map((k) => k.areaLabel))].join(", ")}</div>
              <h2 id="brand-sync-title" className="mt-1 truncate text-lg font-semibold tracking-tight text-zinc-900">
                {title}
              </h2>
            </div>
            <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden>
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          </div>
          <div className="mt-3 space-y-1.5">
            {p.keys.map((k) => (
              <div key={k.key} className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-inset ring-zinc-100">
                {p.keys.length > 1 && <span className="text-xs font-medium text-zinc-700">{k.label}</span>}
                {k.isNew ? <span className="text-xs text-zinc-600">New · {k.nextShort}</span> : <Diff changes={k.brandChanges} max={6} />}
                {k.note && <span className="basis-full text-[11px] text-zinc-500">{k.note}</span>}
              </div>
            ))}
          </div>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-5 py-3">
          <Segmented
            value={scope}
            onChange={(s) => {
              setScope(s);
              if (s === "selected" && !picked.size) setPicked(new Set(lines.map((l) => l.id)));
            }}
            options={[
              { id: "all", label: `All shops · ${lines.length}`, hint: SCOPE_HINT.all },
              { id: "selected", label: scope === "selected" ? `Selected · ${picked.size}` : "Selected shops", hint: SCOPE_HINT.selected },
              { id: "brand_only", label: "Brand only", hint: SCOPE_HINT.brand_only },
            ]}
          />
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <span>Select</span>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-800" onClick={() => setAll(lines.map((l) => l.id))}>
              all
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-800" onClick={() => setAll([])}>
              none
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-800" onClick={() => setAll(lines.filter((l) => !l.overridden).map((l) => l.id))}>
              following brand
            </button>
          </div>
        </div>

        {(overriddenCount > 0 || pending.length > 0 || lines.length > 8) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-2.5">
            {lines.length > 8 && (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter shops"
                className="h-8 w-44 rounded-md border-0 bg-zinc-50 px-2.5 text-sm ring-1 ring-inset ring-zinc-200 placeholder:text-zinc-400 focus:ring-2 focus:ring-brand-600"
              />
            )}
            {overriddenCount > 0 && (
              <span className="flex items-center gap-2 text-xs text-violet-800">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                {overriddenCount} shop{overriddenCount === 1 ? " has" : "s have"} its own value
                <span className="text-zinc-400">·</span>
                <button type="button" className="font-medium underline decoration-violet-300 underline-offset-2" onClick={() => setOverrides(Object.fromEntries(lines.filter((l) => l.overridden).map((l) => [l.id, "keep"])))}>
                  Keep all
                </button>
                <button type="button" className="font-medium underline decoration-violet-300 underline-offset-2" onClick={() => setOverrides(Object.fromEntries(lines.filter((l) => l.overridden).map((l) => [l.id, "replace"])))}>
                  Replace all
                </button>
              </span>
            )}
            {pending.length > 0 && (
              <span className="text-xs text-sky-800">
                {pending.length} scheduled sync{pending.length === 1 ? "" : "s"} for this setting still to run ({whenText(pending[0].runAt)}){pending.length > 1 ? " and more" : ""}
              </span>
            )}
          </div>
        )}

        <ul className="min-h-0 flex-1 divide-y divide-zinc-100 overflow-y-auto" data-testid="brand-sync-shops">
          {shown.map((l) => {
            const on = targeted(l.id);
            const keep = l.overridden && overrides[l.id] !== "replace";
            const single = l.cells.length === 1 ? l.cells[0] : null;
            const changes = l.cells.flatMap((c) => c.changes);
            return (
              <li key={l.id} className={cx("px-5 py-2.5 transition", on ? "bg-white" : "bg-zinc-50/60")} data-testid={`sync-shop-${l.name}`}>
                <div className="flex items-center gap-3">
                  <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-zinc-300 accent-brand-600" checked={on} onChange={() => toggle(l.id)} aria-label={`Sync to ${l.name}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className={cx("text-sm font-medium", on ? "text-zinc-900" : "text-zinc-500")}>{l.name}</span>
                      <StatusPill status={l.status} />
                    </div>
                    <div className="mt-0.5">
                      {!on ? (
                        <span className="text-xs text-zinc-500">Keeps {single ? single.current : "what it has"} · shows out of sync until pushed</span>
                      ) : keep ? (
                        <span className="text-xs text-violet-800">Keeps its own {single ? single.current : "values"}</span>
                      ) : single ? (
                        <Diff changes={single.changes} />
                      ) : (
                        <button type="button" className="text-xs text-zinc-600 hover:text-zinc-900" onClick={() => setOpen(open === l.id ? null : l.id)}>
                          {changes.length ? `${l.cells.filter((c) => c.changes.length).length} of ${l.cells.length} settings change` : "No change"} {open === l.id ? "▴" : "▾"}
                        </button>
                      )}
                    </div>
                  </div>
                  {l.overridden && on && (
                    <Segmented
                      size="sm"
                      value={overrides[l.id] ?? "keep"}
                      onChange={(v) => setOverrides((o) => ({ ...o, [l.id]: v }))}
                      options={[
                        { id: "keep", label: "Keep theirs", hint: "Leave this shop's own value" },
                        { id: "replace", label: "Replace", hint: "Give this shop the brand value" },
                      ]}
                    />
                  )}
                </div>
                {open === l.id && !single && (
                  <div className="ml-7 mt-2 space-y-1 rounded-lg bg-zinc-50 p-2 ring-1 ring-inset ring-zinc-100">
                    {l.cells.map((c) => (
                      <div key={c.key.key} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="w-40 shrink-0 truncate text-xs font-medium text-zinc-700">{c.key.label}</span>
                        <Diff changes={c.changes} max={4} muted={keep} />
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          {!shown.length && <li className="px-5 py-8 text-center text-sm text-zinc-500">No shops match</li>}
        </ul>

        <footer className="border-t border-zinc-100 bg-zinc-50/80 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {scope !== "brand_only" && (
                <>
                  <Segmented
                    size="sm"
                    value={when}
                    onChange={setWhen}
                    options={[
                      { id: "now", label: "Apply now" },
                      { id: "later", label: "Schedule" },
                    ]}
                  />
                  {when === "later" && (
                    <input
                      type="datetime-local"
                      value={runAt}
                      onChange={(e) => setRunAt(e.target.value)}
                      aria-label="Run at"
                      className="h-7 rounded-md border-0 bg-white px-2 text-xs ring-1 ring-inset ring-zinc-300 focus:ring-2 focus:ring-brand-600"
                    />
                  )}
                </>
              )}
              <span className="text-xs text-zinc-500" data-testid="brand-sync-summary">
                {scope === "brand_only"
                  ? `Saved to the brand. All ${lines.length} shops keep what they have.`
                  : [
                      `${changing.length} shop${changing.length === 1 ? " updates" : "s update"}`,
                      keeping.length && `${keeping.length} keep${keeping.length === 1 ? "s its" : " their"} own`,
                      holding.length && `${holding.length} not synced`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={saving} data-testid="brand-sync-confirm">
                {saving ? "Saving…" : cta}
                <kbd className="hidden rounded bg-white/20 px-1 text-[10px] font-medium sm:inline">⌘↵</kbd>
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}

/** For a brand editor's save bar: what the last sync did. */
export function syncedText(r: CommitResult) {
  if (r.status === "scheduled") return `Scheduled for ${new Date(r.runAt!).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  const kept = r.kept ? `; ${r.kept} kept ${r.kept === 1 ? "its" : "their"} own` : "";
  return (r.shops ? `Saved and synced to ${r.shops} shop${r.shops === 1 ? "" : "s"}` : "Saved to the brand") + kept;
}

/** useBrandSync with a save-bar message: "Saved and synced to 4 shops", or the error. */
export function useSyncSave() {
  const s = useBrandSync();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = (o: OpenSync) => {
    setMsg(null);
    void s.open({
      ...o,
      onDone: (r) => {
        setMsg({ ok: true, text: syncedText(r) });
        o.onDone?.(r);
      },
    });
  };
  return { pending: s.pending, msg: s.error ? { ok: false, text: s.error } : msg, save, dialog: s.dialog };
}
