"use client";

import { useEffect, useState } from "react";
import { cx } from "./ui";

type Tone = "success" | "error" | "info";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const EVENT = "rayz-toast";
let next = 1;

/** A short confirmation in the corner ("Appointment moved"). Errors that need fixing stay inline next to the form. */
export function toast(message: string, tone: Tone = "success") {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { id: next++, message, tone } }));
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setList((l) => [...l.slice(-2), t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), 3500);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <div aria-live="polite" role="status" className="no-print pointer-events-none fixed inset-x-0 top-3 z-[65] flex flex-col items-center gap-2 px-3" data-testid="toaster">
      {list.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium shadow-lg ring-1 motion-safe:animate-[toast-in_160ms_ease-out]",
            t.tone === "error" ? "bg-red-600 text-white ring-red-700" : t.tone === "info" ? "bg-white text-zinc-900 ring-zinc-200" : "bg-zinc-900 text-white ring-black/10",
          )}
        >
          {t.tone === "success" && (
            <svg viewBox="0 0 20 20" className="size-4 shrink-0 text-emerald-400" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.79 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
            </svg>
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}
