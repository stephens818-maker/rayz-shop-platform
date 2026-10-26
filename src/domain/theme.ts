export type ThemePref = "light" | "dark" | "system";

export const THEME_KEY = "rayz-theme";
export const THEME_LABEL: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "Match this device" };

/** Light until someone picks Dark or "Match this device", so a shared front-desk tablet doesn't change look by itself. */
export const parseThemePref = (v: unknown): ThemePref => (v === "dark" || v === "system" ? v : "light");

export const isDark = (pref: ThemePref, systemDark: boolean) => pref === "dark" || (pref === "system" && systemDark);

/**
 * Runs before the staff app paints, so a dark preference doesn't flash white. Kept in step with
 * parseThemePref and isDark above.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
