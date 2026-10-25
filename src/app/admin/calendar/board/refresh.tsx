"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Keeps today's board live: refetches every minute while the tab is visible. */
export function LiveRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
