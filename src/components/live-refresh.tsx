"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the page's server data on an interval while the tab is visible, without a reload. */
export function LiveRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
