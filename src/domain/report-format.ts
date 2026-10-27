import { formatCents } from "@/lib/money";
import type { Cell, ColumnKind } from "./report-views";

/** A report cell as shown on the page and in the PDF: dollars, percents, hours from minutes. */
export function formatCell(v: Cell, kind: ColumnKind | undefined) {
  if (v === null || v === "") return "—";
  if (kind === "money" && typeof v === "number") return formatCents(v);
  if (kind === "pct" && typeof v === "number") return `${Math.round(v * 100)}%`;
  if (kind === "hours" && typeof v === "number") return (v / 60).toFixed(1);
  if (kind === "decimal" && typeof v === "number") return v.toFixed(2);
  if (kind === "minutes" && typeof v === "number") return v.toFixed(1);
  if (kind === "minutes_delta" && typeof v === "number") return `${v > 0.05 ? "+" : v < -0.05 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
  if (kind === "bool") return v ? "Yes" : "";
  return String(v);
}

export const numericKind = (k?: ColumnKind) => k === "money" || k === "int" || k === "pct" || k === "hours" || k === "decimal" || k === "minutes" || k === "minutes_delta";
