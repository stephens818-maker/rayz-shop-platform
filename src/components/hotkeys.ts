"use client";

import { useEffect, useRef } from "react";
import { hotkeyOf, isTypingTarget } from "@/domain/shortcuts";

/** Combinations that still work while typing in a field. */
const WHILE_TYPING = new Set(["mod+k", "mod+enter", "escape"]);
const SEQUENCE_MS = 1200;
let sequenceAt = 0;

/** "G" was pressed: the next letter is a jump, not a page shortcut. */
export function startSequence() {
  sequenceAt = Date.now();
}
/** Whether a jump is waiting for its letter; consumes it. */
export function takeSequence(): boolean {
  const on = Date.now() - sequenceAt < SEQUENCE_MS;
  sequenceAt = 0;
  return on;
}

/**
 * Page keyboard shortcuts, keyed by hotkeyOf() strings ("t", "arrowleft", "mod+enter"). Single keys
 * are ignored while typing in a field, while a dialog (the command palette) is open over the page,
 * and right after "G" (that letter is a jump). A handler returning false lets the key through.
 * `global` is for the layout's own jumps, which handle the "G" sequence themselves.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => boolean | void>, opts: { enabled?: boolean; global?: boolean } = {}) {
  const ref = useRef(map);
  ref.current = map;
  const { enabled = true, global = false } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const k = hotkeyOf(e);
      if (!k) return;
      const fn = ref.current[k];
      if (!fn) return;
      if (!WHILE_TYPING.has(k)) {
        if (isTypingTarget(e.target as HTMLElement | null)) return;
        if (document.querySelector("[data-hotkeys-block]")) return;
        if (!global && Date.now() - sequenceAt < SEQUENCE_MS) return;
      }
      if (fn(e) === false) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, global]);
}
