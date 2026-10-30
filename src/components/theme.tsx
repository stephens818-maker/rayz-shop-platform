"use client";

import { useEffect, useSyncExternalStore } from "react";
import { THEME_KEY, ThemePref, isDark, parseThemePref } from "@/domain/theme";

const EVENT = "rayz-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function read(): ThemePref {
  try {
    return parseThemePref(window.localStorage.getItem(THEME_KEY));
  } catch {
    return "light";
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** This device's choice (kept in the browser, not the account, so a shared tablet has its own). */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, read, () => "light");
}

export function setThemePref(p: ThemePref) {
  try {
    window.localStorage.setItem(THEME_KEY, p);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

const SWITCH: { pref: ThemePref; label: string }[] = [
  { pref: "light", label: "Light" },
  { pref: "dark", label: "Dark" },
  { pref: "system", label: "Auto" },
];

/** Light, Dark or Auto (match the device), for the sidebar. */
export function ThemeSwitch() {
  const pref = useThemePref();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md bg-white/5 p-0.5 text-[11px]" data-testid="theme-switch">
      {SWITCH.map((s) => (
        <button
          key={s.pref}
          type="button"
          role="radio"
          aria-checked={pref === s.pref}
          title={s.pref === "system" ? "Match this device" : undefined}
          onClick={() => setThemePref(s.pref)}
          className={pref === s.pref ? "rounded bg-white/15 px-2 py-0.5 font-medium text-white" : "rounded px-2 py-0.5 text-zinc-400 hover:text-white"}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** Applies the choice to <html> while the staff app is open, follows the device when set to match it, and clears it on the way out. */
export function ThemeController() {
  const pref = useThemePref();
  useEffect(() => {
    const m = media();
    const apply = () => document.documentElement.classList.toggle("dark", isDark(pref, m.matches));
    apply();
    m.addEventListener("change", apply);
    return () => m.removeEventListener("change", apply);
  }, [pref]);
  useEffect(() => () => document.documentElement.classList.remove("dark"), []);
  return null;
}
