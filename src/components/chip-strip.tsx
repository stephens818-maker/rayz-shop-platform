"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cx } from "./ui";

/**
 * A row of chips or tabs: wraps from `sm` up, and on a phone stays one line that swipes sideways
 * (the page itself never scrolls sideways), with the current chip (`aria-current`) scrolled into view.
 */
export function ChipStrip({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const on = el?.querySelector<HTMLElement>("[aria-current]");
    if (!el || !on || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
  });
  return (
    <div
      ref={ref}
      role={label ? "group" : undefined}
      aria-label={label}
      className={cx(
        "relative -mx-3 flex flex-nowrap overflow-x-auto px-3 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 [&>*]:whitespace-nowrap",
        className?.includes("gap-") ? null : "gap-1",
        className,
      )}
    >
      {children}
    </div>
  );
}
