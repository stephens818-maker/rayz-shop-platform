"use client";

import { useEffect } from "react";

/**
 * Inside the booking widget's iframe: tells the page around it how tall the content is, so the frame
 * grows with it. Messages carry no client details.
 */
export function EmbedFrame() {
  useEffect(() => {
    if (window.parent === window) return;
    let last = 0;
    const post = () => {
      const h = Math.ceil(document.documentElement.scrollHeight);
      if (h === last) return;
      last = h;
      window.parent.postMessage({ type: "rayz:height", height: h }, "*");
    };
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    post();
    return () => ro.disconnect();
  }, []);
  return null;
}

/** "rayz:booked" for the host page's own thank-you or conversion tracking: which location only, never who or the booking's link. */
export function EmbedEvent({ type, location }: { type: "rayz:booked"; location: string }) {
  useEffect(() => {
    if (window.parent !== window) window.parent.postMessage({ type, location }, "*");
  }, [type, location]);
  return null;
}
