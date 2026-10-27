import { DEFAULT_DISPLAY, displaySettings, type DisplaySettings } from "@/domain/display";
import { setPayrollHoursStyle } from "@/lib/hours";
import { setClockFormat } from "@/lib/time";
import { brandColumn } from "@/server/brand-sync/settings";

const TTL_MS = 30_000;
// On globalThis like the formats themselves, so every server bundle of this module shares one cache.
const CACHE_KEY = "__rayzDisplayCache";
type Cache = { at: number; v: DisplaySettings } | null;
const cache = {
  get: (): Cache => (globalThis as { [CACHE_KEY]?: Cache })[CACHE_KEY] ?? null,
  set: (c: Cache) => void ((globalThis as { [CACHE_KEY]?: Cache })[CACHE_KEY] = c),
};

function apply(v: DisplaySettings): void {
  setClockFormat(v.clockFormat);
  setPayrollHoursStyle(v.payrollHours);
}

/**
 * The brand's display settings, applied to this server's formatters (formatTime, formatPayHours).
 * The root layout, the staff API and startup call it; it reads the database at most every 30
 * seconds, and a saved change is read again on the next request.
 */
export async function loadDisplay(): Promise<DisplaySettings> {
  const c = cache.get();
  if (c && Date.now() - c.at < TTL_MS) return c.v;
  try {
    const v = displaySettings(await brandColumn("display"));
    cache.set({ at: Date.now(), v });
    apply(v);
    return v;
  } catch {
    return c?.v ?? DEFAULT_DISPLAY;
  }
}

/** A change was saved: the next loadDisplay reads it. Other servers pick it up within 30 seconds. */
export function forgetDisplay(): void {
  cache.set(null);
}
