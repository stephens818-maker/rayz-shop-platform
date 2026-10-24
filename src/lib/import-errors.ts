import type { ImportRowError } from "@/db/schema";

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Skipped rows as a CSV: the reason first, then the original Squire columns unchanged, so the file
 * can be fixed in a spreadsheet and re-imported as is (the extra columns are ignored).
 */
export function errorsCsv(errors: ImportRowError[]): string {
  const cols: string[] = [];
  for (const e of errors) for (const k of Object.keys(e.data ?? {})) if (!cols.includes(k)) cols.push(k);
  const header = ["Import row", "Skip reason", "Details", ...cols];
  const lines = errors.map((e) => [e.row, e.reason, e.message, ...cols.map((c) => e.data?.[c] ?? "")].map(esc).join(","));
  return [header.map(esc).join(","), ...lines].join("\n") + "\n";
}
