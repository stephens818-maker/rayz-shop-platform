import { Card, CardHeader, cx } from "@/components/ui";
import type { BarChart } from "@/domain/report-charts";
import type { ColumnKind } from "@/domain/report-views";
import { formatCents } from "@/lib/money";

function fmt(kind: ColumnKind, v: number) {
  if (kind === "money") return formatCents(v);
  if (kind === "hours") return `${(v / 60).toFixed(1)} h`;
  if (kind === "pct") return `${(v * 100).toFixed(1)}%`;
  return v.toLocaleString("en-US");
}

const W = 720;
const H = 200;
const PAD = { l: 8, r: 8, t: 8, b: 24 };
/** Stacked parts, in legend order. */
const PART_BG = ["bg-brand-600/85", "bg-sky-500/85", "bg-amber-500/85", "bg-emerald-600/80", "bg-zinc-400"];
const PART_FILL = ["fill-brand-600/85", "fill-sky-500/85", "fill-amber-500/85", "fill-emerald-600/80", "fill-zinc-400"];

function Legend({ chart }: { chart: BarChart }) {
  if (!chart.legend?.length && !chart.reference) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-1 text-xs text-zinc-600" aria-label="Legend">
      {chart.legend?.map((l, i) => (
        <li key={l} className="inline-flex items-center gap-1.5">
          <span className={cx("inline-block h-2.5 w-2.5 rounded-sm", PART_BG[i % PART_BG.length])} />
          {l}
        </li>
      ))}
      {chart.reference && (
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-0 border-l-2 border-dashed border-red-600" />
          {chart.reference.label}
        </li>
      )}
    </ul>
  );
}

/**
 * A report table's main number as bars: ranked (largest first) or over time, stacked when the bars
 * have parts, with an optional threshold line. The table below has every row and the exact figures.
 */
export function BarChartCard({ chart }: { chart: BarChart }) {
  const max = Math.max(...chart.bars.map((b) => b.value), chart.reference?.value ?? 0, 1);
  const total = chart.bars.reduce((a, b) => a + Math.max(0, b.value), 0);
  const share = !chart.reference && chart.kind !== "hours" && chart.kind !== "pct";
  const plotH = H - PAD.t - PAD.b;
  return (
    <Card className="mt-4" data-testid={`bar-chart-${chart.id}`}>
      <CardHeader title={chart.title} subtitle={chart.subtitle} />
      <Legend chart={chart} />
      {chart.shape === "rank" ? (
        <ol className="space-y-1.5 px-4 py-3" aria-label={chart.title}>
          {chart.bars.map((b) => (
            <li key={b.label} className="grid grid-cols-[minmax(6rem,11rem)_1fr_auto] items-center gap-3 text-sm">
              <span className="truncate text-zinc-700" title={b.label}>
                {b.label}
              </span>
              <span className="relative flex h-5 overflow-hidden rounded bg-zinc-100">
                {b.parts ? (
                  b.parts.map((p, i) => (
                    <span
                      key={i}
                      title={`${chart.legend?.[i] ?? ""}: ${fmt(chart.kind, p)}`}
                      className={cx("block h-full transition-[width] duration-500", PART_BG[i % PART_BG.length])}
                      style={{ width: `${(Math.max(0, p) / max) * 100}%` }}
                    />
                  ))
                ) : (
                  <span
                    className={cx("block h-full rounded transition-[width] duration-500", b.warn ? "bg-amber-500/90" : "bg-brand-600/85")}
                    style={{ width: `${(Math.max(0, b.value) / max) * 100}%` }}
                  />
                )}
                {chart.reference && <span aria-hidden className="absolute inset-y-0 border-l-2 border-dashed border-red-600" style={{ left: `${(chart.reference.value / max) * 100}%` }} />}
              </span>
              <span className={cx("tabular w-24 text-right", b.warn ? "font-medium text-amber-700" : "text-zinc-900")}>
                {fmt(chart.kind, b.value)}
                {share && total > 0 && <span className="ml-1 text-[11px] text-zinc-400">{Math.round((Math.max(0, b.value) / total) * 100)}%</span>}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="px-4 pb-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={chart.title}>
            {[0.25, 0.5, 0.75, 1].map((g) => (
              <line key={g} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + (1 - g) * plotH} y2={PAD.t + (1 - g) * plotH} className="stroke-zinc-200" strokeWidth={1} />
            ))}
            {chart.bars.map((b, i) => {
              const n = chart.bars.length;
              const slot = (W - PAD.l - PAD.r) / n;
              const x = PAD.l + i * slot + slot * 0.15;
              const every = Math.max(1, Math.ceil(n / 10));
              let y = H - PAD.b;
              const parts = b.parts ?? [b.value];
              return (
                <g key={i}>
                  {parts.map((p, j) => {
                    const h = (Math.max(0, p) / max) * plotH;
                    y -= h;
                    return (
                      <rect
                        key={j}
                        x={x}
                        y={y}
                        width={slot * 0.7}
                        height={Math.max(h, j === 0 ? 0.5 : 0)}
                        rx={b.parts ? 0 : Math.min(3, slot * 0.2)}
                        className={b.parts ? PART_FILL[j % PART_FILL.length] : b.warn ? "fill-amber-500/90" : "fill-brand-600/85"}
                      >
                        <title>{`${b.label}${b.parts ? ` · ${chart.legend?.[j] ?? ""}` : ""}: ${fmt(chart.kind, p)}`}</title>
                      </rect>
                    );
                  })}
                  {(i % every === 0 || i === n - 1) && (
                    <text x={PAD.l + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={11} className="fill-zinc-500">
                      {b.label.replace(/^Week of /, "").replace(/^\d{4}-/, "")}
                    </text>
                  )}
                </g>
              );
            })}
            {chart.reference && (
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={H - PAD.b - (chart.reference.value / max) * plotH}
                y2={H - PAD.b - (chart.reference.value / max) * plotH}
                className="stroke-red-600"
                strokeWidth={1.5}
                strokeDasharray="6 4"
              >
                <title>{chart.reference.label}</title>
              </line>
            )}
          </svg>
          <p className="text-xs text-zinc-500">Highest: {fmt(chart.kind, Math.max(...chart.bars.map((b) => b.value), 0))}</p>
        </div>
      )}
    </Card>
  );
}
