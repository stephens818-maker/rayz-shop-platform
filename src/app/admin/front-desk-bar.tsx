"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { cx } from "@/components/ui";
import type { NavItem } from "@/domain/navigation";

/** The shop login's tabs: large enough to tap on a front-desk tablet, with everything else under More. */
export function FrontDeskBar({ tabs, more }: { tabs: NavItem[]; more: NavItem[] }) {
  const path = usePathname();
  const details = useRef<HTMLDetailsElement>(null);
  const matches = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));
  const best = [...tabs, ...more]
    .map((i) => i.href)
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  useEffect(() => {
    if (details.current) details.current.open = false;
  }, [path]);
  const inMore = more.some((i) => i.href === best);
  return (
    <nav aria-label="Front desk" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" data-testid="front-desk-tabs">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === best ? "page" : undefined}
          className={cx(
            "flex h-12 shrink-0 items-center rounded-xl px-4 text-base font-medium",
            t.href === best ? "bg-white text-zinc-900" : "text-zinc-200 hover:bg-white/10 hover:text-white",
          )}
        >
          {t.label}
        </Link>
      ))}
      {more.length > 0 && (
        <details ref={details} className="relative shrink-0" data-testid="front-desk-more">
          <summary
            className={cx(
              "flex h-12 cursor-pointer list-none items-center rounded-xl px-4 text-base font-medium [&::-webkit-details-marker]:hidden",
              inMore ? "bg-white text-zinc-900" : "text-zinc-200 hover:bg-white/10 hover:text-white",
            )}
          >
            More
          </summary>
          <div className="fixed right-3 z-50 mt-2 max-h-[70dvh] w-72 overflow-y-auto rounded-2xl bg-white p-2 text-zinc-900 shadow-xl ring-1 ring-zinc-200">
            {more.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                className={cx("flex h-12 items-center rounded-xl px-4 text-base", i.href === best ? "bg-zinc-100 font-semibold" : "hover:bg-zinc-50")}
              >
                {i.label}
              </Link>
            ))}
          </div>
        </details>
      )}
    </nav>
  );
}
