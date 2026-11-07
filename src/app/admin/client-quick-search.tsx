"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ClientHitRow } from "@/components/client-hit";
import type { ClientHit } from "@/domain/client-search";
import { quickFindClientsAction } from "./customers/actions";

/** Find a client from any page: any name, number, card or code. "/" jumps here. */
export function ClientQuickSearch() {
  const router = useRouter();
  const box = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ClientHit[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !(t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)))) {
        e.preventDefault();
        box.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(async () => {
      const r = await quickFindClientsAction(q);
      if (!r.ok) return;
      setHits(r.data);
      setActive(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const open = (id: string) => {
    setQ("");
    setHits([]);
    router.push(`/admin/customers/${id}`);
  };
  return (
    <div className="relative px-3 pb-2" data-testid="client-quick-search">
      <input
        ref={box}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Escape") {
            setQ("");
            setHits([]);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (hits[active]) open(hits[active].id);
            else if (q.trim()) router.push(`/admin/customers?q=${encodeURIComponent(q.trim())}`);
          }
        }}
        placeholder="Find a client  /"
        aria-label="Find a client"
        className="h-9 w-full rounded-lg bg-white/10 px-3 text-sm text-white placeholder:text-zinc-400 focus:bg-white/15 focus:outline-none focus:ring-1 focus:ring-white/30"
      />
      {hits.length > 0 && (
        <div className="absolute inset-x-3 z-30 mt-1 w-[22rem] max-w-[calc(100vw-1.5rem)] divide-y divide-zinc-100 overflow-hidden rounded-lg bg-white text-zinc-900 shadow-xl ring-1 ring-zinc-200">
          {hits.map((h, i) => (
            <button key={h.id} type="button" onMouseEnter={() => setActive(i)} onClick={() => open(h.id)} className={`block w-full px-3 py-2 text-left text-sm ${i === active ? "bg-zinc-50" : ""}`}>
              <ClientHitRow hit={h} />
            </button>
          ))}
          <button type="button" onClick={() => router.push(`/admin/customers?q=${encodeURIComponent(q.trim())}`)} className="block w-full px-3 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-50">
            See every match on the client list ›
          </button>
        </div>
      )}
    </div>
  );
}
