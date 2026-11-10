"use client";

import { useEffect } from "react";

/**
 * A page restored from the browser's back/forward cache never reaches the server, so it would skip
 * the hand-off lock in the middleware. Reloading it sends it back through.
 */
export function BfcacheGuard() {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  return null;
}
