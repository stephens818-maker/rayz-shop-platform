"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { SegmentFilters } from "@/components/segment-filters";
import { Button, LinkButton, Notice, Select, cx } from "@/components/ui";
import { encodeFilter, type FilterOptions, type PanelSees } from "@/domain/client-filters";
import { filterCount, type Segment } from "@/domain/marketing";
import { CLIENT_SORTS, RATING_FILTERS } from "@/domain/ratings";
import { deleteClientSearchAction, saveClientSearchAction } from "./actions";

export interface SavedSearchItem {
  id: string;
  name: string;
  visibility: "private" | "shop" | "brand";
  shop: string | null;
  owner: string;
  mine: boolean;
  mayDelete: boolean;
  term: string;
  f: string;
}

const VIS_LABEL = { private: "Only me", shop: "This location", brand: "Everyone in the brand" } as const;

function href(q: string, f: string, extra: Record<string, string | null> = {}) {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (f) qs.set("f", f);
  for (const [k, v] of Object.entries(extra)) if (v) qs.set(k, v);
  const s = qs.toString();
  return `/admin/customers${s ? `?${s}` : ""}`;
}

/**
 * The client list's search box, filters, saved searches, and the filtered export and blast. The
 * search reads anything that identifies a client (see parseSearch); the filters are the Campaign
 * Center's segment filters.
 */
export function ClientListControls(p: {
  q: string;
  seg: Segment;
  rating: string | null;
  sort: string;
  /** Null without "Use advanced client filters". */
  options: FilterOptions | null;
  sees: PanelSees;
  saved: SavedSearchItem[];
  maySave: boolean;
  share: { shop: boolean; brand: boolean };
  mayExport: boolean;
  mayBlast: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(p.q);
  const [seg, setSeg] = useState<Segment>(p.seg);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [vis, setVis] = useState<"private" | "shop" | "brand">("private");
  const [error, setError] = useState<string | null>(null);
  const applied = encodeFilter(p.seg);
  const n = filterCount(p.seg);
  const go = (nq: string, f: string) => router.push(href(nq.trim(), f, { rating: p.rating, sort: p.sort === "recent" ? null : p.sort }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(q, open ? encodeFilter(seg) : applied);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await saveClientSearchAction({ name, visibility: vis, term: p.q, segment: p.seg });
      if (!r.ok) return setError(r.error);
      setSaving(false);
      setName("");
      router.refresh();
    });
  };
  const remove = (id: string, label: string) => {
    if (!confirm(`Delete the saved search "${label}"?`)) return;
    start(async () => {
      const r = await deleteClientSearchAction(id);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  };
  const exportQs = new URLSearchParams();
  if (p.q) exportQs.set("q", p.q);
  if (applied) exportQs.set("f", applied);

  return (
    <div className="mb-4 space-y-3">
      <form className="flex flex-wrap gap-2" onSubmit={submit}>
        <input
          name="q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, nickname, phone, email, client #, ticket #, gift card, coupon, zip, tag…"
          aria-label="Search clients"
          className="h-10 w-full max-w-md rounded-lg px-3 text-sm ring-1 ring-zinc-300"
          autoFocus
        />
        <select
          defaultValue={p.rating ?? ""}
          aria-label="Filter by staff rating"
          className="h-10 rounded-lg px-2 text-sm ring-1 ring-zinc-300"
          onChange={(e) => router.push(href(p.q, applied, { rating: e.target.value || null, sort: p.sort === "recent" ? null : p.sort }))}
        >
          <option value="">Any rating</option>
          {Object.entries(RATING_FILTERS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          defaultValue={p.sort}
          aria-label="Sort"
          className="h-10 rounded-lg px-2 text-sm ring-1 ring-zinc-300"
          onChange={(e) => router.push(href(p.q, applied, { rating: p.rating, sort: e.target.value === "recent" ? null : e.target.value }))}
        >
          {Object.entries(CLIENT_SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {p.q && k === "recent" ? "Best match" : v}
            </option>
          ))}
        </select>
        {p.options && (
          <Button type="button" variant={n ? "dark" : "secondary"} aria-expanded={open} onClick={() => setOpen(!open)}>
            Filters{n ? ` (${n})` : ""}
          </Button>
        )}
        <Button className="bg-ink-900 hover:bg-ink-700" disabled={pending}>
          Search
        </Button>
      </form>

      {open && p.options && (
        <div className="rounded-xl bg-white p-3 ring-1 ring-zinc-200">
          <SegmentFilters seg={seg} onChange={(x) => setSeg({ ...seg, ...x })} options={p.options} sees={p.sees} />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => (setSeg(p.seg), go(q, ""))}>
              Clear filters
            </Button>
            <Button type="button" onClick={() => (setOpen(false), go(q, encodeFilter(seg)))}>
              Apply filters
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {p.saved.length > 0 && (
          <>
            <span className="text-xs font-medium text-zinc-500">Saved:</span>
            {p.saved.map((s) => {
              const active = s.term === p.q && s.f === applied;
              return (
                <span key={s.id} className={cx("inline-flex items-center rounded-full ring-1", active ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300")}>
                  <Link
                    href={href(s.term, s.f)}
                    className="py-1 pl-2.5 pr-2 text-xs"
                    title={`${VIS_LABEL[s.visibility]}${s.shop ? ` (${s.shop})` : ""}${s.mine ? "" : `, by ${s.owner}`}`}
                  >
                    {s.name}
                    {s.visibility !== "private" && <span className="ml-1 opacity-60">{s.visibility === "brand" ? "· brand" : "· shop"}</span>}
                  </Link>
                  {s.mayDelete && (
                    <button type="button" aria-label={`Delete ${s.name}`} className="pr-2 text-xs opacity-60 hover:opacity-100" onClick={() => remove(s.id, s.name)}>
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </>
        )}
        <span className="ml-auto flex flex-wrap gap-2">
          {p.maySave && (p.q || applied) && !saving && (
            <Button size="sm" variant="secondary" onClick={() => setSaving(true)}>
              Save this search
            </Button>
          )}
          {p.mayBlast && applied && (
            <LinkButton size="sm" variant="secondary" href={`/admin/campaign-center/blasts/new?f=${applied}`}>
              Message these clients
            </LinkButton>
          )}
          {p.mayExport && (
            <LinkButton size="sm" variant="secondary" href={`/admin/customers/export${exportQs.size ? `?${exportQs}` : ""}`} prefetch={false}>
              {p.q || applied ? "Export these" : "Export"}
            </LinkButton>
          )}
        </span>
      </div>

      {saving && (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-2 ring-1 ring-zinc-200">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Lapsed fade regulars" className="h-9 w-64 rounded-lg px-3 text-sm ring-1 ring-zinc-300" required autoFocus />
          <Select className="w-auto" value={vis} onChange={(e) => setVis(e.target.value as typeof vis)} aria-label="Who can use it">
            <option value="private">{VIS_LABEL.private}</option>
            {p.share.shop && <option value="shop">{VIS_LABEL.shop}</option>}
            {p.share.brand && <option value="brand">{VIS_LABEL.brand}</option>}
          </Select>
          <Button size="sm" disabled={pending || !name.trim()}>
            Save
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setSaving(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}
