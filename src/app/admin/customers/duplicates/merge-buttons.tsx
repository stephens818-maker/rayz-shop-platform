"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Table, Td, Th } from "@/components/ui";
import type { ActionResult } from "@/server/action";
import { dismissDuplicateAction, mergeCustomersAction, mergeDuplicatesAction } from "../actions";

export interface DupPerson {
  id: string;
  label: string;
  detail: string;
  squire: boolean;
  visits: number;
}

export interface DupRow {
  a: DupPerson;
  b: DupPerson;
  score: number;
  signals: string[];
  conflicts: string[];
  /** Which side a bulk merge keeps. */
  keeps: "a" | "b";
}

const key = (r: DupRow) => `${r.a.id}:${r.b.id}`;

function Person({ p, kept }: { p: DupPerson; kept: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Link className="font-medium underline" href={`/admin/customers/${p.id}`}>
          {p.label}
        </Link>
        {p.squire && <Badge tone="blue">Squire import</Badge>}
      </div>
      <div className="text-xs text-zinc-500">
        {p.detail}
        {p.detail ? " · " : ""}
        {p.visits} visit{p.visits === 1 ? "" : "s"}
      </div>
      {kept && <div className="text-xs font-medium text-emerald-700">Kept when merged</div>}
    </div>
  );
}

/**
 * One group of candidate pairs. Each pair can be merged either way or marked "not the same
 * person"; checked pairs merge together, each keeping the record with more visits (then the older).
 */
export function DuplicateGroup({ rows }: { rows: DupRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = <T,>(fn: () => Promise<ActionResult<T>>, after?: (v: T) => void) =>
    start(async () => {
      setError(null);
      setDone(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.(r.data);
      setPicked(new Set());
      router.refresh();
    });

  const merge = (keep: DupPerson, drop: DupPerson) => {
    if (!confirm(`Keep ${keep.label} and merge ${drop.label} into it? This can't be undone (the audit log keeps a copy).`)) return;
    run(() => mergeCustomersAction(keep.id, drop.id));
  };
  const chosen = rows.filter((r) => picked.has(key(r)));
  const mergeChosen = () => {
    if (!confirm(`Merge ${chosen.length} pair${chosen.length === 1 ? "" : "s"}? Each keeps the record with more visits, then the older one. This can't be undone (the audit log keeps a copy).`)) return;
    run(
      () => mergeDuplicatesAction(chosen.map((r) => ({ a: r.a.id, b: r.b.id }))),
      (r) => {
        setDone(`Merged ${r.merged}${r.failed.length ? `; ${r.failed.length} couldn't be merged (already changed), refresh and check` : ""}.`);
      },
    );
  };
  const toggle = (r: DupRow) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key(r))) n.delete(key(r));
      else n.add(key(r));
      return n;
    });
  const clean = rows.filter((r) => !r.conflicts.length);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-2 text-sm">
        <Button size="sm" variant="secondary" disabled={pending || !clean.length} onClick={() => setPicked(new Set(clean.map(key)))}>
          Select all without conflicts ({clean.length})
        </Button>
        {picked.size > 0 && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPicked(new Set())}>
            Clear
          </Button>
        )}
        <Button size="sm" disabled={pending || !chosen.length} onClick={mergeChosen}>
          Merge selected ({chosen.length})
        </Button>
        {done && <span className="text-xs text-emerald-700">{done}</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
      <Table>
        <thead>
          <tr>
            <Th />
            <Th>Client A</Th>
            <Th>Client B</Th>
            <Th>Why</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={key(r)}>
              <Td>
                <input type="checkbox" aria-label={`Select ${r.a.label} and ${r.b.label}`} checked={picked.has(key(r))} onChange={() => toggle(r)} disabled={pending} />
              </Td>
              <Td className="whitespace-normal">
                <Person p={r.a} kept={picked.has(key(r)) && r.keeps === "a"} />
              </Td>
              <Td className="whitespace-normal">
                <Person p={r.b} kept={picked.has(key(r)) && r.keeps === "b"} />
              </Td>
              <Td className="whitespace-normal text-xs text-zinc-600">
                <div className="flex items-center gap-1.5">
                  <Badge tone={r.score >= 70 ? "green" : r.score >= 40 ? "amber" : "gray"}>{r.score}</Badge>
                  <span>{r.signals.join(", ")}</span>
                </div>
                {r.conflicts.length > 0 && <div className="mt-0.5 text-red-700">Differs: {r.conflicts.join(", ")}</div>}
              </Td>
              <Td right>
                <div className="flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => merge(r.a, r.b)}>
                    Keep A
                  </Button>
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => merge(r.b, r.a)}>
                    Keep B
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => dismissDuplicateAction(r.a.id, r.b.id))}>
                    Not the same person
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
