import { isDate, isPreset, resolveSavedRange, type SavedRange } from "@rayz/api";

export const RANGE_KEY = "rayz.team.earnings.range";

/** Presets recompute from today. Custom keeps the dates that were stored. */
export function loadRange(raw: string | null, today: string): SavedRange {
  if (!raw) return resolveSavedRange(null, today);
  try {
    const parsed = JSON.parse(raw) as Partial<SavedRange>;
    if (!parsed.preset || !isPreset(parsed.preset) || !parsed.from || !parsed.to || !isDate(parsed.from) || !isDate(parsed.to)) {
      return resolveSavedRange(null, today);
    }
    return resolveSavedRange({ preset: parsed.preset, from: parsed.from, to: parsed.to }, today);
  } catch {
    return resolveSavedRange(null, today);
  }
}
