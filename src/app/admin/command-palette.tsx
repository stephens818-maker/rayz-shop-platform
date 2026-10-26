"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ClientHitRow } from "@/components/client-hit";
import { startSequence, takeSequence, useHotkeys } from "@/components/hotkeys";
import { setThemePref, useThemePref } from "@/components/theme";
import { cx } from "@/components/ui";
import type { ClientHit } from "@/domain/client-search";
import { Command, rankCommands, strongMatch } from "@/domain/command-search";
import type { NavItem } from "@/domain/navigation";
import { shortcutGroups } from "@/domain/shortcuts";
import { THEME_LABEL, ThemePref } from "@/domain/theme";
import { logout } from "../login/actions";
import { switchShop } from "./actions";
import { quickFindClientsAction } from "./customers/actions";

const OPEN_EVENT = "rayz-command-palette";

/** Opens the palette from a button (the sidebar's "Search" for touch screens). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandPaletteButton({ className }: { className?: string }) {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iP(hone|ad|od)/.test(navigator.platform)), []);
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className={cx("flex h-9 w-full items-center gap-2 rounded-lg bg-white/10 px-3 text-sm text-zinc-400 hover:bg-white/15 hover:text-white", className)}
      data-testid="open-command-palette"
    >
      <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="currentColor" aria-hidden>
        <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.4 9.83l3.13 3.14a.75.75 0 1 0 1.06-1.06l-3.13-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" />
      </svg>
      <span className="flex-1 truncate text-left">Search…</span>
      <kbd className="hidden rounded bg-white/10 px-1.5 text-[11px] font-medium text-zinc-300 sm:inline">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

type Row = Command & { run?: () => void; hint?: string; client?: ClientHit };

export function CommandPalette({
  sections,
  reports,
  shops,
  currentShopId,
  combined,
  brandWide,
  findClients,
  goTo,
}: {
  sections: { title: string; items: NavItem[] }[];
  reports: { label: string; href: string; group: string }[];
  shops: { id: string; name: string }[];
  currentShopId: string | null;
  combined: boolean;
  brandWide: boolean;
  findClients: boolean;
  /** The "G then a letter" jumps this person can use. */
  goTo: { key: string; href: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [clients, setClients] = useState<ClientHit[]>([]);
  const [mac, setMac] = useState(false);
  const [, start] = useTransition();
  const theme = useThemePref();
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);

  useEffect(() => setMac(/Mac|iP(hone|ad|od)/.test(navigator.platform)), []);

  const show = () => {
    back.current = document.activeElement as HTMLElement | null;
    setHelp(false);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQ("");
    setClients([]);
    setActive(0);
    back.current?.focus?.();
  };

  useEffect(() => {
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  useHotkeys(
    {
      "mod+k": () => (open ? close() : show()),
      "?": () => {
        setOpen(false);
        setHelp((h) => !h);
      },
      g: () => startSequence(),
      ...Object.fromEntries(
        goTo.map((g) => [
          g.key,
          () => {
            if (!takeSequence()) return false;
            router.push(g.href);
          },
        ]),
      ),
    },
    { global: true },
  );

  useEffect(() => {
    if (!open) return;
    box.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !findClients || q.trim().length < 2) return setClients([]);
    const t = setTimeout(async () => {
      const r = await quickFindClientsAction(q);
      if (r.ok) setClients(r.data.slice(0, 6));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, findClients]);

  const commands = useMemo<Row[]>(() => {
    const go = (href: string) => () => router.push(href);
    const pages: Row[] = sections.flatMap((s) =>
      s.items.map((i) => ({ id: `page:${i.href}`, label: i.label, group: "Pages", keywords: s.title, href: i.href, hint: s.title, run: go(i.href) })),
    );
    const reps: Row[] = reports.map((r) => ({ id: `report:${r.href}`, label: r.label, group: "Reports", keywords: `report ${r.group}`, href: r.href, hint: r.group, run: go(r.href) }));
    const switches: Row[] =
      shops.length > 1
        ? [
            ...(combined && currentShopId ? [{ id: "shop:all", label: brandWide ? "All shops (brand)" : "All my shops", group: "Switch shop", keywords: "location every", run: () => start(() => switchShop("all")) }] : []),
            ...shops
              .filter((s) => s.id !== currentShopId)
              .map((s) => ({ id: `shop:${s.id}`, label: `Switch to ${s.name}`, group: "Switch shop", keywords: "location shop", run: () => start(() => switchShop(s.id)) })),
          ]
        : [];
    const themes: Row[] = (["light", "dark", "system"] as ThemePref[])
      .filter((p) => p !== theme)
      .map((p) => ({ id: `theme:${p}`, label: `Theme: ${THEME_LABEL[p]}`, group: "Actions", keywords: "dark light mode appearance color", run: () => setThemePref(p) }));
    const actions: Row[] = [
      ...themes,
      { id: "help", label: "Keyboard shortcuts", group: "Actions", keywords: "keys hotkeys help", run: () => setHelp(true) },
      { id: "logout", label: "Sign out", group: "Actions", keywords: "log out leave", run: () => start(() => logout()) },
    ];
    return [...pages, ...reps, ...switches, ...actions];
  }, [sections, reports, shops, currentShopId, combined, brandWide, theme, router]);

  const rows = useMemo<Row[]>(() => {
    const ranked = rankCommands(q, commands, q.trim() ? 40 : commands.length);
    const people: Row[] = clients.map((c) => ({ id: `client:${c.id}`, label: c.short, group: "Clients", client: c, run: () => router.push(`/admin/customers/${c.id}`) }));
    if (!q.trim()) {
      const order = ["Pages", "Reports", "Switch shop", "Actions"];
      return [...ranked].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    }
    return ranked.length > 0 && strongMatch(q, ranked[0]) ? [...groupInOrder(ranked), ...people] : [...people, ...groupInOrder(ranked)];
  }, [q, commands, clients, router]);

  useEffect(() => setActive(0), [q, clients.length]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (r: Row | undefined) => {
    if (!r) return;
    close();
    r.run?.();
  };

  if (help) {
    return (
      <Overlay onClose={() => setHelp(false)} label="Keyboard shortcuts">
        <div className="max-h-[70vh] overflow-y-auto p-5" data-testid="shortcut-help">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-zinc-900">Keyboard shortcuts</h2>
            <button type="button" onClick={() => setHelp(false)} className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100">
              Close
            </button>
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            {shortcutGroups(goTo, mac).map((g) => (
              <section key={g.title} className={g.title === "Everywhere" ? "sm:row-span-2" : undefined}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{g.title}</h3>
                <dl className="space-y-1.5 text-sm">
                  {g.items.map((i) => (
                    <div key={i.label} className="flex items-center justify-between gap-3">
                      <dt className="text-zinc-700">{i.label}</dt>
                      <dd className="flex shrink-0 gap-1">
                        {i.keys.map((k) => (
                          <kbd key={k} className="min-w-6 rounded bg-zinc-100 px-1.5 py-0.5 text-center text-xs font-medium text-zinc-700 ring-1 ring-inset ring-zinc-200">
                            {k}
                          </kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </Overlay>
    );
  }
  if (!open) return null;

  let lastGroup = "";
  return (
    <Overlay onClose={close} label="Command palette">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4">
        <svg viewBox="0 0 20 20" className="size-4 shrink-0 text-zinc-400" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.4 9.83l3.13 3.14a.75.75 0 1 0 1.06-1.06l-3.13-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" />
        </svg>
        <input
          ref={box}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          aria-activedescendant={rows[active] ? `cmd-${active}` : undefined}
          aria-label="Search pages, reports, clients and actions"
          placeholder={findClients ? "Search pages, reports, clients, actions…" : "Search pages, reports, actions…"}
          className="h-12 flex-1 bg-transparent text-base text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
          data-testid="command-input"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (rows[active]) choose(rows[active]);
              else if (findClients && q.trim()) {
                close();
                router.push(`/admin/customers?q=${encodeURIComponent(q.trim())}`);
              }
            } else if (e.key === "Tab") {
              e.preventDefault();
            }
          }}
        />
        <kbd className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">esc</kbd>
      </div>
      <div ref={list} id="command-list" role="listbox" aria-label="Results" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2" data-testid="command-list">
        {rows.length === 0 && <p className="px-3 py-8 text-center text-sm text-zinc-500">{q.trim().length >= 2 && findClients ? "No page or client matches." : "Nothing matches."}</p>}
        {rows.map((r, i) => {
          const heading = r.group !== lastGroup ? r.group : null;
          lastGroup = r.group;
          return (
            <div key={r.id}>
              {heading && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{heading}</div>}
              <div
                id={`cmd-${i}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(r)}
                className={cx("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm", i === active ? "bg-zinc-100 text-zinc-900" : "text-zinc-700")}
              >
                {r.client ? (
                  <div className="min-w-0 flex-1">
                    <ClientHitRow hit={r.client} />
                  </div>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    {r.hint && <span className="shrink-0 text-xs text-zinc-400">{r.hint}</span>}
                  </>
                )}
                {i === active && <span className="shrink-0 text-xs text-zinc-400" aria-hidden>↵</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400">
        <span>↑↓ move · ↵ open · esc close</span>
        <button type="button" className="hover:text-zinc-700" onClick={() => setHelp(true)}>
          ? Keyboard shortcuts
        </button>
      </div>
    </Overlay>
  );
}

/** Keeps the ranking but lists each group once, groups in the order of their best match. */
function groupInOrder<T extends { group: string }>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  return [...groups.values()].flat();
}

function Overlay({ onClose, label, children }: { onClose: () => void; label: string; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-3 pt-[10vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-hotkeys-block>
      <div role="dialog" aria-modal="true" aria-label={label} className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-zinc-200">
        {children}
      </div>
    </div>
  );
}
