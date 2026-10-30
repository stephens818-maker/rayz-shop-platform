"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  dismissCongratsAction,
  milestoneToastsAction,
} from "@/app/admin/milestones/actions";
import { Button, cx } from "@/components/ui";

/** Tell the live toast to check now, e.g. right after a ticket is paid. */
export const MILESTONE_CHECK_EVENT = "rayz:milestones-check";
export const checkMilestonesNow = () =>
  window.dispatchEvent(new Event(MILESTONE_CHECK_EVENT));

const COLORS = [
  "#f59e0b",
  "#ec4899",
  "#0ea5e9",
  "#22c55e",
  "#a855f7",
  "#ef4444",
];

export function ConfettiIcon({
  className,
  title,
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("size-5", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path
        d="M4 20 8.5 7.5l8 8L4 20Z"
        fill="#fde68a"
        stroke="#b45309"
        strokeWidth={1.5}
      />
      <path d="M8.5 7.5 16.5 15.5" stroke="#b45309" strokeWidth={1.5} />
      <path
        d="M13 4.5c.8.8.8 2 0 2.8M19.5 11c-.8-.8-2-.8-2.8 0"
        stroke="#ec4899"
        strokeWidth={1.6}
      />
      <path d="M17 3.5v2M16 4.5h2" stroke="#0ea5e9" strokeWidth={1.6} />
      <path d="M20 7.5v1.6M19.2 8.3h1.6" stroke="#22c55e" strokeWidth={1.6} />
      <circle cx="11" cy="3.5" r="0.9" fill="#a855f7" />
      <circle cx="20.5" cy="14.5" r="0.9" fill="#ef4444" />
    </svg>
  );
}

/** A short burst of falling confetti over its (relatively positioned) parent. */
function Confetti({ pieces = 18 }: { pieces?: number }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 h-0 overflow-visible"
      aria-hidden
    >
      {Array.from({ length: pieces }, (_, i) => (
        <span
          key={i}
          className="confetti-piece absolute top-0 block h-2 w-1.5 rounded-[1px]"
          style={{
            left: `${(i * 53) % 100}%`,
            background: COLORS[i % COLORS.length],
            ["--drift" as string]: `${((i * 37) % 7) - 3}rem`,
            ["--delay" as string]: `${(i % 6) * 0.12}s`,
          }}
        />
      ))}
    </div>
  );
}

/** Today's milestones across the top of the calendar or the POS: "Today is Jamie's 1,000th cut!". */
export function CelebrationBanner({
  items,
  className,
}: {
  items: { id: string; text: string }[];
  className?: string;
}) {
  if (!items.length) return null;
  return (
    <div
      className={cx(
        "relative flex items-start gap-3 overflow-hidden rounded-xl bg-gradient-to-r from-amber-50 via-pink-50 to-sky-50 px-4 py-3 text-amber-950 ring-1 ring-amber-200",
        className,
      )}
      role="status"
      aria-label="Celebrating today"
      data-testid="celebration-banner"
    >
      <Confetti pieces={14} />
      <ConfettiIcon className="mt-0.5 size-6 shrink-0" />
      <ul className="min-w-0 space-y-0.5 text-sm font-semibold sm:text-base">
        {items.map((c) => (
          <li key={c.id}>{c.text}</li>
        ))}
      </ul>
    </div>
  );
}

/** The congratulations window: on clocking in, and when they open their portal. */
export function CelebrationModal({
  title,
  lines,
  onClose,
  closeLabel = "Thanks!",
  autoCloseMs,
  pending,
}: {
  title: string;
  lines: string[];
  onClose: () => void;
  closeLabel?: string;
  autoCloseMs?: number;
  pending?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    button.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", esc);
    const t = autoCloseMs
      ? setTimeout(() => close.current(), autoCloseMs)
      : null;
    return () => {
      window.removeEventListener("keydown", esc);
      if (t) clearTimeout(t);
    };
  }, [autoCloseMs]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="celebration-title"
        className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-white p-6 text-center shadow-2xl ring-1 ring-zinc-200"
        onClick={(e) => e.stopPropagation()}
        data-testid="celebration-modal"
      >
        <Confetti />
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-amber-100 ring-4 ring-amber-50">
          <ConfettiIcon className="size-8" />
        </div>
        <h2 id="celebration-title" className="mt-4 text-xl font-semibold">
          {title}
        </h2>
        <ul className="mt-3 space-y-1.5 text-sm text-zinc-700">
          {lines.map((l) => (
            <li
              key={l}
              className="rounded-lg bg-amber-50 px-3 py-2 font-medium text-amber-950"
            >
              {l}
            </li>
          ))}
        </ul>
        <Button
          ref={button}
          className="mt-5 w-full"
          onClick={onClose}
          disabled={pending}
        >
          {closeLabel}
        </Button>
      </div>
    </div>
  );
}

/** On opening their portal: what they haven't seen yet. Closing it marks it seen. */
export function PortalWelcome({
  firstName,
  items,
}: {
  firstName: string;
  items: { id: string; text: string }[];
}) {
  const [open, setOpen] = useState(items.length > 0);
  const [pending, start] = useTransition();
  if (!open) return null;
  return (
    <CelebrationModal
      title={`Congratulations, ${firstName}!`}
      lines={items.map((i) => i.text)}
      pending={pending}
      onClose={() => {
        setOpen(false);
        start(async () => {
          await dismissCongratsAction(items.map((i) => i.id));
        });
      }}
    />
  );
}

const POLL_MS = 20_000;
const TOAST_MS = 12_000;

/**
 * Live celebration toasts for the shop: polls for counts reached since the page opened (a cut at
 * checkout makes Jamie's 1,000th) and shows each once.
 */
export function MilestoneToasts({ since }: { since: string }) {
  const [toasts, setToasts] = useState<
    { id: string; text: string; mine: boolean }[]
  >([]);
  const cursor = useRef(since);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (document.hidden) return;
      const r = await milestoneToastsAction(cursor.current).catch(() => null);
      if (!live || !r?.ok) return;
      // Overlap a minute so a row stamped by a slightly different clock isn't skipped.
      cursor.current = new Date(Date.parse(r.data.now) - 60_000).toISOString();
      const fresh = r.data.items.filter((i) => !shown.current.has(i.id));
      if (!fresh.length) return;
      for (const i of fresh) shown.current.add(i.id);
      setToasts((t) => [...t, ...fresh].slice(-4));
      for (const i of fresh)
        setTimeout(
          () => live && setToasts((t) => t.filter((x) => x.id !== i.id)),
          TOAST_MS,
        );
    };
    const t = setInterval(tick, POLL_MS);
    const now = () => void tick();
    window.addEventListener(MILESTONE_CHECK_EVENT, now);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener(MILESTONE_CHECK_EVENT, now);
    };
  }, []);
  return (
    <div
      className="no-print pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl bg-white px-4 py-3 shadow-lg ring-1 ring-amber-200"
          data-testid="celebration-toast"
        >
          <Confetti pieces={12} />
          <ConfettiIcon className="mt-0.5 size-6 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
              {t.mine ? "That's you!" : "Just now"}
            </div>
            <div className="text-sm font-semibold text-zinc-900">{t.text}</div>
          </div>
          <button
            type="button"
            className="-mr-1 rounded p-1 text-zinc-400 hover:text-zinc-700"
            aria-label="Dismiss"
            onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
